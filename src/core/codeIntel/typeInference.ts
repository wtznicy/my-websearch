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
        return inferSyntaxTypeInfo(content, extension, symbol);
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

function splitTopLevel(value: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    for (const char of value) {
        if ('([{<'.includes(char)) depth += 1;
        if (')]}>'.includes(char)) depth = Math.max(0, depth - 1);
        if (char === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function parenthesized(text: string, openIndex: number): { inner: string; end: number } | null {
    if (text[openIndex] !== '(') return null;
    let depth = 0;
    for (let index = openIndex; index < text.length; index += 1) {
        if (text[index] === '(') depth += 1;
        if (text[index] === ')') {
            depth -= 1;
            if (depth === 0) {
                return { inner: text.slice(openIndex + 1, index), end: index };
            }
        }
    }
    return null;
}

function syntaxTypeInfo(type: string | undefined, returnType?: string, parameters?: string[]): CodeTypeInfo | null {
    if (!type && !returnType && (!parameters || parameters.length === 0)) return null;
    return {
        ...(type ? { type } : {}),
        ...(returnType ? { returnType } : {}),
        ...(parameters && parameters.length > 0 ? { parameters } : {})
    };
}

function inferSyntaxTypeInfo(content: string, extension: string, symbol: string): CodeTypeInfo | null {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (extension === '.py') {
        const classMatch = content.match(new RegExp(`^\\s*class\\s+${escaped}\\b`, 'm'));
        if (classMatch) return syntaxTypeInfo(symbol);
        const functionMatch = content.match(new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\s*\\(`, 'm'));
        if (!functionMatch || functionMatch.index === undefined) return null;
        const open = content.indexOf('(', functionMatch.index);
        const params = parenthesized(content, open);
        if (!params) return null;
        const after = content.slice(params.end + 1);
        const returnMatch = after.match(/^\s*->\s*([^:\n]+)/);
        const parameters = splitTopLevel(params.inner).map((part) => {
            const declaration = part.split('=')[0] ?? part;
            const [name, ...typeParts] = declaration.split(':');
            return typeParts.length > 0 ? `${name?.trim()}: ${typeParts.join(':').trim()}` : name?.trim() || part;
        }).filter(Boolean);
        return syntaxTypeInfo(
            `(${parameters.join(', ')})${returnMatch?.[1] ? ` -> ${returnMatch[1].trim()}` : ''}`,
            returnMatch?.[1]?.trim(),
            parameters
        );
    }

    if (extension === '.go') {
        if (new RegExp(`^\\s*type\\s+${escaped}\\s+(?:struct|interface)\\b`, 'm').test(content)) {
            return syntaxTypeInfo(symbol);
        }
        const match = content.match(new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\s*\\(`, 'm'));
        if (!match || match.index === undefined) return null;
        const nameIndex = content.indexOf(symbol, match.index);
        const open = content.indexOf('(', nameIndex >= 0 ? nameIndex : match.index);
        const params = parenthesized(content, open);
        if (!params) return null;
        const after = content.slice(params.end + 1).split('{')[0]?.trim() ?? '';
        const parameters = splitTopLevel(params.inner);
        return syntaxTypeInfo(
            `func(${parameters.join(', ')})${after ? ` ${after}` : ''}`,
            after || undefined,
            parameters
        );
    }

    if (extension === '.rs') {
        if (new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait)\\s+${escaped}\\b`, 'm').test(content)) {
            return syntaxTypeInfo(symbol);
        }
        const match = content.match(new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escaped}\\s*[<(]`, 'm'));
        if (!match || match.index === undefined) return null;
        const open = content.indexOf('(', match.index);
        const params = parenthesized(content, open);
        if (!params) return null;
        const after = content.slice(params.end + 1).split('{')[0]?.split('where')[0]?.trim() ?? '';
        const returnMatch = after.match(/->\s*(.+)$/);
        const parameters = splitTopLevel(params.inner).map((part) => part.trim()).filter(Boolean);
        return syntaxTypeInfo(
            `fn(${parameters.join(', ')})${returnMatch?.[1] ? ` -> ${returnMatch[1].trim()}` : ''}`,
            returnMatch?.[1]?.trim(),
            parameters
        );
    }

    return null;
}
