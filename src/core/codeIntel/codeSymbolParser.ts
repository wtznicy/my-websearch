import path from 'node:path';
import { CodeSymbolDefinition, CodeSymbolKind } from './types.js';

export function detectCodeLanguage(filePath: string): string {
    const extension = filePath.toLowerCase().split('.').pop() ?? '';
    const map: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        py: 'python',
        go: 'go',
        rs: 'rust',
        java: 'java',
        kt: 'kotlin',
        cs: 'csharp',
        cpp: 'cpp',
        cc: 'cpp',
        cxx: 'cpp',
        h: 'c',
        hpp: 'cpp'
    };
    return map[extension] ?? (extension || 'unknown');
}

const CODE_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'cs', 'cpp', 'cc', 'cxx', 'h', 'hpp'
]);
const LOW_PRIORITY_PATH = /(^|\/)(docs?|documentation|examples?|test|tests|__tests__|spec|specs|scripts|fixtures?|benchmarks?|ee|mocks?)(\/|$)/i;
const GENERATED_PATH = /(^|\/)(dist|build|vendor|node_modules|coverage|\.next)(\/|$)/i;

export function isCodeFilePath(filePath: string): boolean {
    const extension = filePath.toLowerCase().split('.').pop() ?? '';
    return CODE_EXTENSIONS.has(extension);
}

export function isKindCompatible(declaredKind: string, requestedKind?: CodeSymbolKind): boolean {
    if (!requestedKind) return true;
    if (declaredKind === requestedKind) return true;
    if (requestedKind === 'function' && (declaredKind === 'method' || declaredKind === 'const')) {
        return true;
    }
    if (requestedKind === 'class' && (declaredKind === 'struct' || declaredKind === 'const')) {
        return true;
    }
    if (requestedKind === 'type' && (declaredKind === 'interface' || declaredKind === 'struct' || declaredKind === 'enum')) {
        return true;
    }
    if (requestedKind === 'interface' && (declaredKind === 'type' || declaredKind === 'class')) {
        return true;
    }
    if (requestedKind === 'method' && declaredKind === 'function') {
        return true;
    }
    return false;
}

/** Rank code-search hits so src/index files are scanned before docs/tests/generated files. */
export function rankCodePaths(paths: string[], symbol?: string): string[] {
    const normalizedSymbol = symbol?.trim().toLowerCase();
    const kebabSymbol = symbol
        ?.trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z0-9])/g, '$1-$2')
        .toLowerCase();
    const snakeSymbol = symbol
        ?.trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();

    const score = (filePath: string): number => {
        if (!isCodeFilePath(filePath) || GENERATED_PATH.test(filePath)) return Number.NEGATIVE_INFINITY;
        let value = 0;
        const ext = path.posix.extname(filePath);
        const baseName = path.posix.basename(filePath, ext).toLowerCase();

        // Exact or strong basename match with symbol name gets the highest priority boost
        if (normalizedSymbol) {
            if (baseName === normalizedSymbol || (kebabSymbol && baseName === kebabSymbol) || (snakeSymbol && baseName === snakeSymbol)) {
                value += 300;
            } else if (baseName.includes(normalizedSymbol) || (kebabSymbol && baseName.includes(kebabSymbol))) {
                value += 120;
            }
        }

        if (/(^|\/)(src|lib)(\/|$)/i.test(filePath)) value += 100;
        if (/(^|\/)(packages|apps|libs)\/[^/]+\/(src|lib)(\/|$)/i.test(filePath)) value += 80;
        if (/(^|\/)(index|main|mod)\.(ts|tsx|js|py|go|rs)$/i.test(filePath)) value += 70;
        if (LOW_PRIORITY_PATH.test(filePath)) value -= 120;
        return value;
    };

    return [...new Set(paths)]
        .filter((filePath) => Number.isFinite(score(filePath)))
        .sort((left, right) => score(right) - score(left) || left.localeCompare(right));
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function declarationPatterns(language: string, symbol: string): Array<{ kind: string; pattern: RegExp }> {
    const name = escapeRegExp(symbol);
    switch (language) {
        case 'typescript':
        case 'javascript':
            return [
                { kind: 'class', pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?class\\s+${name}\\b`) },
                { kind: 'interface', pattern: new RegExp(`^\\s*(?:export\\s+)?interface\\s+${name}\\b`) },
                { kind: 'type', pattern: new RegExp(`^\\s*(?:export\\s+)?type\\s+${name}\\b`) },
                { kind: 'function', pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${name}\\b`) },
                { kind: 'const', pattern: new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`) },
                { kind: 'enum', pattern: new RegExp(`^\\s*(?:export\\s+)?enum\\s+${name}\\b`) }
            ];
        case 'python':
            return [
                { kind: 'class', pattern: new RegExp(`^\\s*class\\s+${name}\\b`) },
                { kind: 'function', pattern: new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\b`) }
            ];
        case 'go':
            return [
                { kind: 'function', pattern: new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${name}\\b`) },
                { kind: 'type', pattern: new RegExp(`^\\s*type\\s+${name}\\b`) }
            ];
        case 'rust':
            return [
                { kind: 'function', pattern: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\b`) },
                { kind: 'struct', pattern: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+${name}\\b`) },
                { kind: 'enum', pattern: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?enum\\s+${name}\\b`) },
                { kind: 'trait', pattern: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?trait\\s+${name}\\b`) },
                { kind: 'type', pattern: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?type\\s+${name}\\b`) },
                { kind: 'const', pattern: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const|static)\\s+${name}\\b`) }
            ];
        case 'java':
        case 'kotlin':
        case 'csharp':
            return [
                { kind: 'class', pattern: new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|internal\\s+)?(?:abstract\\s+|final\\s+)?class\\s+${name}\\b`) },
                { kind: 'interface', pattern: new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|internal\\s+)?interface\\s+${name}\\b`) },
                { kind: 'enum', pattern: new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|internal\\s+)?enum\\s+${name}\\b`) }
            ];
        default:
            // Unknown/non-code files must never fall through to a loose
            // "symbol(" regex: Markdown prose would be reported as a function.
            return [];
    }
}

export function braceEndLine(lines: string[], startIndex: number): number {
    let depth = 0;
    let seenBrace = false;
    let mode = 'normal';
    let regexAllowed = true;

    for (let index = startIndex; index < Math.min(lines.length, startIndex + 400); index += 1) {
        const line = lines[index] ?? '';
        for (let cursor = 0; cursor < line.length; cursor += 1) {
            const char = line.charAt(cursor);
            const next = line.charAt(cursor + 1);

            if (mode === 'line') break;
            if (mode === 'block') {
                if (char === '*' && next === '/') {
                    mode = 'normal';
                    cursor += 1;
                }
                continue;
            }
            if (mode === 'single' || mode === 'double' || mode === 'template') {
                if (char === '\\') {
                    cursor += 1;
                } else if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"') || (mode === 'template' && char === '`')) {
                    mode = 'normal';
                }
                continue;
            }
            if (char === '/' && next === '/') {
                mode = 'line';
                break;
            }
            if (char === '/' && next === '*') {
                mode = 'block';
                cursor += 1;
                continue;
            }
            if (char === "'") {
                mode = 'single';
                continue;
            }
            if (char === '"') {
                mode = 'double';
                continue;
            }
            if (char === '`') {
                mode = 'template';
                continue;
            }

            if (char === '/' && regexAllowed) {
                let scan = cursor + 1;
                let inClass = false;
                let closed = false;
                for (; scan < line.length; scan += 1) {
                    const regexChar = line[scan];
                    if (regexChar === '\\') {
                        scan += 1;
                        continue;
                    }
                    if (regexChar === '[') {
                        inClass = true;
                        continue;
                    }
                    if (regexChar === ']') {
                        inClass = false;
                        continue;
                    }
                    if (regexChar === '/' && !inClass) {
                        closed = true;
                        break;
                    }
                }
                if (closed) {
                    cursor = scan;
                    regexAllowed = false;
                    continue;
                }
            }

            if (char === '{') {
                depth += 1;
                seenBrace = true;
            } else if (char === '}') {
                depth -= 1;
                if (seenBrace && depth === 0) {
                    return index;
                }
            }

            if (!/\s/.test(char)) {
                const before = line.slice(0, cursor);
                regexAllowed = /[=(:,![{;?&|+\-*%^~<>]/.test(char)
                    || /\b(return|case|throw|typeof|void|delete|in|of|yield|await)\s*$/.test(before);
            }
        }

        if (mode === 'single' || mode === 'double') {
            mode = 'normal';
        }
        if (mode === 'line') {
            mode = 'normal';
        }
    }

    return Math.min(lines.length - 1, startIndex + 40);
}

export function decoratorStart(lines: string[], declarationIndex: number, language: string): number {
    if (language !== 'python') {
        return declarationIndex;
    }
    let start = declarationIndex;
    while (start > 0 && lines[start - 1]?.trim().startsWith('@')) {
        start -= 1;
    }
    return start;
}

export function collectSignature(lines: string[], startIndex: number, language: string): string {
    const parts: string[] = [];
    for (let index = startIndex; index < Math.min(lines.length, startIndex + 20); index += 1) {
        const raw = (lines[index] ?? '').trim();
        if (!raw) continue;

        if (language === 'python') {
            if (raw.startsWith('@')) {
                parts.push(raw);
                continue;
            }
            parts.push(raw.endsWith(':') ? raw.slice(0, -1).trim() : raw);
            if (raw.endsWith(':')) break;
            continue;
        }

        const braceIndex = raw.indexOf('{');
        if (braceIndex >= 0) {
            const beforeBrace = raw.slice(0, braceIndex).trim();
            if (beforeBrace) parts.push(beforeBrace);
            break;
        }
        parts.push(raw);
        if (raw.endsWith(';')) break;
        if (parts.join(' ').length > 500) break;
    }

    const signature = parts.join(' ').replace(/\s+/g, ' ').trim();
    return signature.length > 500 ? `${signature.slice(0, 500)}…` : signature;
}

export function pythonBlockEndLine(lines: string[], startIndex: number): number {
    const baseIndent = (lines[startIndex]?.match(/^\s*/)?.[0].length) ?? 0;
    let end = startIndex;
    for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 200); index += 1) {
        const line = lines[index] ?? '';
        if (!line.trim()) {
            continue;
        }
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        if (indent <= baseIndent) break;
        end = index;
    }
    return end;
}

export function extractCodeDefinitions(
    content: string,
    filePath: string,
    symbol: string,
    kind?: CodeSymbolKind
): CodeSymbolDefinition[] {
    const language = detectCodeLanguage(filePath);
    const lines = content.split(/\r?\n/);
    const patterns = declarationPatterns(language, symbol).filter(({ kind: declaredKind }) => isKindCompatible(declaredKind, kind));
    const definitions: CodeSymbolDefinition[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        for (const { kind: declaredKind, pattern } of patterns) {
            if (!pattern.test(line)) continue;
            const startIndex = decoratorStart(lines, index, language);
            const endIndex = language === 'python'
                ? pythonBlockEndLine(lines, index)
                : braceEndLine(lines, index);
            const codeLines = lines.slice(startIndex, endIndex + 1);
            const maxLines = 60;
            const truncatedByLines = codeLines.length > maxLines;
            let code = codeLines.slice(0, maxLines).join('\n');
            const truncatedByChars = code.length > 8000;
            if (truncatedByChars) code = code.slice(0, 8000);
            if (truncatedByLines || truncatedByChars) {
                const comment = language === 'python' ? '#' : '//';
                code += `\n${comment} ... [truncated: showing ${Math.min(codeLines.length, maxLines)} of ${codeLines.length} lines]`;
            }
            definitions.push({
                path: filePath,
                language,
                kind: declaredKind,
                signature: collectSignature(lines, startIndex, language),
                startLine: startIndex + 1,
                endLine: endIndex + 1,
                code,
                truncated: truncatedByLines || truncatedByChars
            });
            break;
        }
    }
    definitions.sort((a, b) => {
        if (kind) {
            const aExact = a.kind === kind ? 1 : 0;
            const bExact = b.kind === kind ? 1 : 0;
            if (bExact !== aExact) return bExact - aExact;
        }
        return 0;
    });
    return definitions;
}
