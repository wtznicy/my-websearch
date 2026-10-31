import ts from 'typescript';
import path from 'node:path';

export interface CodeTypeInfo {
    type?: string;
    returnType?: string;
    parameters?: string[];
}

function hasName(node: ts.Node): node is ts.Node & { name: ts.Node } {
    return 'name' in node && Boolean((node as { name?: ts.Node }).name);
}

function findDeclaration(sourceFile: ts.SourceFile, symbol: string): ts.Node | undefined {
    let found: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (hasName(node) && node.name.getText(sourceFile) === symbol) {
            found = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

/**
 * Best-effort semantic type information for TypeScript/JavaScript.
 *
 * The virtual program only contains the fetched file, so imports that are not
 * present become `any`; local literals, parameters and annotations are still
 * resolved by the TypeScript checker.
 */
export function inferTypeInfo(
    content: string,
    filePath: string,
    symbol: string
): CodeTypeInfo | null {
    const extension = path.extname(filePath).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].includes(extension)) {
        return null;
    }

    try {
        const virtualName = `/virtual/${path.basename(filePath).replace(/[^\w.-]/g, '_')}`;
        const scriptKind = extension.includes('x') ? ts.ScriptKind.TSX : (extension.startsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
        const sourceFile = ts.createSourceFile(virtualName, content, ts.ScriptTarget.ES2022, true, scriptKind);
        const options: ts.CompilerOptions = {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            skipLibCheck: true,
            noEmit: true,
            allowJs: true,
            jsx: ts.JsxEmit.Preserve,
            types: []
        };
        const host = ts.createCompilerHost(options);
        const originalGetSourceFile = host.getSourceFile.bind(host);
        host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
            if (fileName === virtualName) return sourceFile;
            return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        };
        host.fileExists = (fileName) => fileName === virtualName || ts.sys.fileExists(fileName);
        host.readFile = (fileName) => fileName === virtualName ? content : ts.sys.readFile(fileName);
        host.writeFile = () => undefined;

        const program = ts.createProgram([virtualName], options, host);
        const checker = program.getTypeChecker();
        const parsed = program.getSourceFile(virtualName) ?? sourceFile;
        const declaration = findDeclaration(parsed, symbol);
        if (!declaration) return null;

        const info: CodeTypeInfo = {};
        if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
            const signature = checker.getSignatureFromDeclaration(declaration);
            if (signature) {
                info.returnType = checker.typeToString(
                    checker.getReturnTypeOfSignature(signature),
                    declaration,
                    ts.TypeFormatFlags.NoTruncation
                );
                info.parameters = signature.parameters.map((parameter) => {
                    const parameterType = checker.getTypeOfSymbolAtLocation(parameter, declaration);
                    return `${parameter.getName()}: ${checker.typeToString(parameterType, declaration, ts.TypeFormatFlags.NoTruncation)}`;
                });
            }
        }

        if (ts.isVariableDeclaration(declaration)) {
            const variableType = checker.getTypeAtLocation(declaration.name);
            const callSignature = variableType.getCallSignatures()[0];
            if (callSignature) {
                info.returnType = checker.typeToString(
                    checker.getReturnTypeOfSignature(callSignature),
                    declaration,
                    ts.TypeFormatFlags.NoTruncation
                );
                info.parameters = callSignature.parameters.map((parameter) => {
                    const parameterType = checker.getTypeOfSymbolAtLocation(parameter, declaration);
                    return `${parameter.getName()}: ${checker.typeToString(parameterType, declaration, ts.TypeFormatFlags.NoTruncation)}`;
                });
            }
        }

        if (hasName(declaration)) {
            const type = checker.getTypeAtLocation(declaration.name);
            info.type = checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation);
        } else {
            const type = checker.getTypeAtLocation(declaration);
            info.type = checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation);
        }

        return info.type || info.returnType || info.parameters ? info : null;
    } catch {
        return null;
    }
}
