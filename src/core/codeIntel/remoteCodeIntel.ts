import { AppError } from '../errors.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';
import path from 'node:path';
import { analyzeWithTreeSitter, type CodeSymbolCallSite } from './treeSitter.js';
import { inferTypeInfo, type CodeTypeInfo } from './typeInference.js';
import { fileAnalysisCache, fileContentCache, hashContent, symbolResultCache } from './codeIntelCache.js';
import { getBoolean, getNumber, getOptionalString } from '../../config/env.js';

export type CodeSymbolKind = 'class' | 'function' | 'interface' | 'type' | 'method' | 'const' | 'enum' | 'struct' | 'trait' | 'namespace';

export interface CodeSymbolInput {
    repo: string;
    symbol: string;
    kind?: CodeSymbolKind;
    ref?: string;
    maxResults?: number;
    signal?: AbortSignal;
}

export interface CodeSymbolDefinition {
    path: string;
    language: string;
    kind: string;
    signature: string;
    startLine: number;
    endLine: number;
    code: string;
    /** Present when the symbol was found through an `export { ... } from` re-export. */
    via?: string;
    truncated?: boolean;
    /** Best-effort TypeScript/JavaScript semantic type info. */
    typeInfo?: CodeTypeInfo;
}

export interface CodeSymbolReference {
    path: string;
    lines: number[];
}

export interface CodeSymbolResult {
    repo: string;
    symbol: string;
    ref: string;
    definitions: CodeSymbolDefinition[];
    references: CodeSymbolReference[];
    callSites: CodeSymbolCallSite[];
    filesScanned: number;
    warnings: string[];
    cached?: boolean;
    partial?: boolean;
}

export function parseGitHubRepoSpec(raw: string): { owner: string; repo: string } | null {
    const trimmed = raw.trim().replace(/\.git$/i, '');
    if (!trimmed) return null;

    const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s?#]+)/i)
        || trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i);
    if (urlMatch?.[1] && urlMatch[2]) {
        return { owner: urlMatch[1], repo: urlMatch[2] };
    }

    const shortMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    return shortMatch?.[1] && shortMatch[2] ? { owner: shortMatch[1], repo: shortMatch[2] } : null;
}

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
const LOW_PRIORITY_PATH = /(^|\/)(docs?|documentation|examples?|test|tests|__tests__|spec|specs|scripts|fixtures?|benchmarks?|e2e|mocks?)(\/|$)/i;
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

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declarationPatterns(language: string, symbol: string): Array<{ kind: string; pattern: RegExp }> {
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

function braceEndLine(lines: string[], startIndex: number): number {
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
                    } else if (regexChar === '[') {
                        inClass = true;
                    } else if (regexChar === ']') {
                        inClass = false;
                    } else if (regexChar === '/' && !inClass) {
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

function decoratorStart(lines: string[], declarationIndex: number, language: string): number {
    if (language !== 'python') {
        return declarationIndex;
    }
    let start = declarationIndex;
    while (start > 0 && lines[start - 1]?.trim().startsWith('@')) {
        start -= 1;
    }
    return start;
}

function collectSignature(lines: string[], startIndex: number, language: string): string {
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

function pythonBlockEndLine(lines: string[], startIndex: number): number {
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

export interface TsconfigPathAlias {
    prefix: string;
    suffix: string;
    targets: string[];
    baseUrl: string;
}

function resolveCandidateExtensions(target: string): string[] {
    const withoutExtension = target.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx)$/i, '');
    const candidates = new Set<string>([target]);
    for (const extension of ['.ts', '.tsx', '.d.ts', '.js', '.jsx']) {
        candidates.add(`${withoutExtension}${extension}`);
        candidates.add(path.posix.join(withoutExtension, `index${extension}`));
    }
    return [...candidates];
}

function resolveModuleCandidates(filePath: string, specifier: string): string[] {
    if (!specifier.startsWith('.')) return [];
    const base = path.posix.dirname(filePath);
    return resolveCandidateExtensions(path.posix.normalize(path.posix.join(base, specifier)));
}

export function parseTsconfigPathAliases(raw: string, configDir = ''): TsconfigPathAlias[] {
    try {
        const withoutComments = raw
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1')
            .replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(withoutComments) as {
            compilerOptions?: {
                baseUrl?: string;
                paths?: Record<string, string[]>;
            };
        };
        const baseUrl = path.posix.normalize(path.posix.join(
            configDir.replace(/^\.\//, ''),
            parsed.compilerOptions?.baseUrl?.replace(/^\.\//, '') || '.'
        ));
        return Object.entries(parsed.compilerOptions?.paths ?? {}).map(([pattern, targets]) => {
            const starIndex = pattern.indexOf('*');
            return {
                prefix: starIndex >= 0 ? pattern.slice(0, starIndex) : pattern,
                suffix: starIndex >= 0 ? pattern.slice(starIndex + 1) : '',
                targets: Array.isArray(targets) ? targets : [],
                baseUrl
            };
        });
    } catch {
        return [];
    }
}

/** Detect `import * as z ...; export { z }` / aliased imports as a symbol binding. */
export function findReExportBinding(
    content: string,
    filePath: string,
    symbol: string
): CodeSymbolDefinition | null {
    const imports = new Map<string, { kind: 'namespace' | 'const' }>();
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        const namespace = line.match(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"]/);
        if (namespace?.[1]) imports.set(namespace[1], { kind: 'namespace' });
        const named = line.match(/^\s*import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/);
        if (named?.[1]) {
            for (const item of named[1].split(',')) {
                const [imported, alias] = item.trim().split(/\s+as\s+/);
                const local = alias ?? imported;
                if (local) imports.set(local.trim(), { kind: 'const' });
            }
        }
    }

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const exported = line.match(/^\s*export\s*\{([^}]*)\}\s*;?\s*$/);
        if (!exported?.[1]) continue;
        const items = exported[1].split(',').map((item) => item.trim()).filter(Boolean);
        const matched = items.some((item) => {
            const [imported, alias] = item.split(/\s+as\s+/).map((part) => part.trim());
            return imported === symbol || alias === symbol;
        });
        if (!matched) continue;
        const kind = imports.get(symbol)?.kind === 'namespace' ? 'namespace' : 'const';
        return {
            path: filePath,
            language: detectCodeLanguage(filePath),
            kind,
            signature: line.trim(),
            startLine: index + 1,
            endLine: index + 1,
            code: line.trim(),
            truncated: false
        };
    }
    return null;
}

/** Resolve `export { X } from './module'` / `export * from './module'` targets. */
export function findReExportTargets(
    content: string,
    filePath: string,
    symbol: string,
    aliases: TsconfigPathAlias[] = []
): string[] {
    const targets: string[] = [];
    const namedTargets: string[] = [];
    const starTargets: string[] = [];
    const resolveSpecifier = (specifier: string): string[] => {
        if (specifier.startsWith('.')) {
            return resolveModuleCandidates(filePath, specifier);
        }
        for (const alias of aliases) {
            if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) continue;
            const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
            for (const target of alias.targets) {
                const resolved = target.replace('*', middle);
                const base = alias.baseUrl === '.' ? '' : alias.baseUrl;
                targets.push(...resolveCandidateExtensions(path.posix.normalize(path.posix.join(base, resolved))));
            }
        }
        return [];
    };

    const lines = content.split(/\r?\n/);
    const importedFrom = new Map<string, string>();
    let exportsSymbol = false;

    for (const line of lines) {
        // Track: import { X } from './mod' / import X from './mod' / import * as X from './mod'
        const importNamed = line.match(/^\s*import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);
        if (importNamed?.[1] && importNamed[2]) {
            const names = importNamed[1].split(',').map((item) => item.trim()).filter(Boolean);
            for (const item of names) {
                const [imported, local] = item.split(/\s+as\s+/).map((part) => part.trim());
                const effectiveLocal = local || imported;
                if (effectiveLocal) importedFrom.set(effectiveLocal, importNamed[2]);
            }
        }
        const importDefaultOrStar = line.match(/^\s*import\s*(?:type\s*)?(?:\*\s+as\s+([\w$]+)|([\w$]+))\s*from\s*['"]([^'"]+)['"]/);
        if (importDefaultOrStar?.[3]) {
            const local = importDefaultOrStar[1] || importDefaultOrStar[2];
            if (local) importedFrom.set(local, importDefaultOrStar[3]);
        }

        // Direct re-export: export { X } from './mod'
        const named = line.match(/^\s*export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);
        if (named?.[1] && named[2]) {
            const names = named[1].split(',').map((item) => item.trim()).filter(Boolean);
            const matches = names.some((item) => {
                const [imported, exported] = item.split(/\s+as\s+/).map((part) => part.trim());
                return imported === symbol || exported === symbol;
            });
            if (matches) namedTargets.push(...resolveSpecifier(named[2]));
            continue;
        }

        // Wildcard re-export: export * from './mod'
        const star = line.match(/^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/);
        if (star?.[1]) {
            starTargets.push(...resolveSpecifier(star[1]));
            continue;
        }

        // Multi-step re-export: export { X } (without from)
        const exportOnly = line.match(/^\s*export\s*(?:type\s*)?\{([^}]*)\}\s*(?:;|$)/);
        if (exportOnly?.[1]) {
            const names = exportOnly[1].split(',').map((item) => item.trim()).filter(Boolean);
            if (names.some((item) => {
                const [local, exported] = item.split(/\s+as\s+/).map((part) => part.trim());
                return local === symbol || exported === symbol;
            })) {
                exportsSymbol = true;
            }
        }
        const exportDefault = line.match(/^\s*export\s+default\s+([\w$]+)\s*(?:;|$)/);
        if (exportDefault?.[1] && exportDefault[1] === symbol) {
            exportsSymbol = true;
        }
    }

    if (exportsSymbol && importedFrom.has(symbol)) {
        const specifier = importedFrom.get(symbol)!;
        namedTargets.push(...resolveSpecifier(specifier));
    }

    targets.push(...namedTargets, ...starTargets);
    return [...new Set(targets)];
}

export function buildRawFileUrls(owner: string, repo: string, ref: string, filePath: string): string[] {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    return [
        `https://raw.githubusercontent.com/${encodedOwner}/${encodedRepo}/${encodeURIComponent(ref)}/${encodedPath}`,
        `https://cdn.jsdelivr.net/gh/${encodedOwner}/${encodedRepo}@${encodeURIComponent(ref)}/${encodedPath}`
    ];
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

interface GitHubCodeSearchItem {
    path?: string;
    text_matches?: Array<{ fragment?: string }>;
}

interface GitHubCodeSearchResponse {
    items?: GitHubCodeSearchItem[];
}

function githubHeaders(): Record<string, string> {
    const token = getOptionalString('GITHUB_TOKEN');
    return {
        'User-Agent': DEFAULT_DESKTOP_UA,
        'Accept': 'application/vnd.github.text-match+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
}

async function searchGitHubCode(
    owner: string,
    repo: string,
    symbol: string,
    maxResults: number,
    signal?: AbortSignal
): Promise<string[]> {
    const token = getOptionalString('GITHUB_TOKEN');
    if (!token) {
        throw new AppError({
            code: 'missing_api_key',
            retryable: false,
            engine: 'github',
            message: 'codeSymbol requires GITHUB_TOKEN for GitHub code search.',
            hint: '配置 GITHUB_TOKEN 后重试；未配置时可用 fetchGithubContent 直接读取已知路径。'
        });
    }

    const query = `${symbol} repo:${owner}/${repo}`;
    const perPage = Math.min(Math.max(maxResults * 10, 50), 100);
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${perPage}`;
    const response = await requestDirectFirst(
        'GET',
        url,
        (forceDirect) => buildAxiosRequestOptions({
            headers: githubHeaders(),
            timeout: 10000,
            responseType: 'json',
            signal,
            forceDirect
        }),
        'GitHub code search'
    );

    if (response.status === 401 || response.status === 403) {
        throw new AppError({
            code: 'engine_error',
            retryable: false,
            engine: 'github',
            message: `GitHub code search returned HTTP ${response.status}.`,
            hint: '检查 GITHUB_TOKEN 是否有效，以及是否有 code search 权限。'
        });
    }
    if (response.status !== 200) {
        throw new AppError({
            code: 'engine_error',
            retryable: response.status >= 500,
            engine: 'github',
            message: `GitHub code search returned HTTP ${response.status}.`
        });
    }

    const data = response.data as GitHubCodeSearchResponse;
    return rankCodePaths((data.items ?? [])
        .map((item) => item.path)
        .filter((path): path is string => Boolean(path)),
        symbol
    );
}

async function fetchRawFile(
    owner: string,
    repo: string,
    ref: string,
    path: string,
    signal?: AbortSignal
): Promise<string | null> {
    for (const url of buildRawFileUrls(owner, repo, ref, path)) {
        if (signal?.aborted) return null;
        try {
            const response = await requestDirectFirst(
                'GET',
                url,
                (forceDirect) => buildAxiosRequestOptions({
                    headers: { 'User-Agent': DEFAULT_DESKTOP_UA },
                    timeout: 8000,
                    responseType: 'text',
                    signal,
                    forceDirect
                }),
                url.includes('cdn.jsdelivr.net') ? 'jsDelivr raw file' : 'GitHub raw file'
            );
            if (response.status === 200 && typeof response.data === 'string') {
                return response.data;
            }
        } catch {
            // Try the next CDN.
        }
    }

    // Private repositories are not served by raw.githubusercontent.com/jsDelivr;
    // use the authenticated Contents API as the last resort.
    const token = getOptionalString('GITHUB_TOKEN');
    if (!token) return null;
    try {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
        const response = await requestDirectFirst(
            'GET',
            apiUrl,
            (forceDirect) => buildAxiosRequestOptions({
                headers: githubHeaders(),
                timeout: 10000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            'GitHub contents API'
        );
        const data = response.data as { content?: string; encoding?: string };
        if (response.status === 200 && data?.content && data.encoding === 'base64') {
            return Buffer.from(data.content.replace(/\s+/g, ''), 'base64').toString('utf8');
        }
    } catch {
        // fall through
    }
    return null;
}

async function fetchTsconfigPaths(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<string[]> {
    try {
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
        const response = await requestDirectFirst(
            'GET',
            url,
            (forceDirect) => buildAxiosRequestOptions({
                headers: githubHeaders(),
                timeout: 10000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            'GitHub tree for tsconfig discovery'
        );
        if (response.status !== 200) return [];
        const data = response.data as { tree?: Array<{ path?: string }> };
        return (data.tree ?? [])
            .map((entry) => entry.path)
            .filter((filePath): filePath is string => typeof filePath === 'string')
            .filter((filePath) =>
                /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(filePath)
                && !filePath.includes('node_modules/')
            )
            .sort((left, right) => {
                const leftPriority = /(^|\/)(packages|apps|libs)\//.test(left) ? 0 : 1;
                const rightPriority = /(^|\/)(packages|apps|libs)\//.test(right) ? 0 : 1;
                return leftPriority - rightPriority || left.localeCompare(right);
            })
            .slice(0, 20);
    } catch {
        return [];
    }
}

export function parseTsconfigExtends(raw: string): string[] {
    try {
        const withoutComments = raw
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1')
            .replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(withoutComments) as { extends?: string | string[] };
        if (typeof parsed.extends === 'string') return [parsed.extends];
        return Array.isArray(parsed.extends) ? parsed.extends.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

async function loadTsconfigAliasesUncached(
    owner: string,
    repo: string,
    refsToTry: string[],
    signal?: AbortSignal
): Promise<TsconfigPathAlias[]> {
    const aliases: TsconfigPathAlias[] = [];
    const seen = new Set<string>();
    const addAliases = (parsed: TsconfigPathAlias[]): void => {
        for (const alias of parsed) {
            const key = `${alias.baseUrl}|${alias.prefix}|${alias.suffix}|${alias.targets.join(',')}`;
            if (!seen.has(key)) {
                seen.add(key);
                aliases.push(alias);
            }
        }
    };

    for (const ref of refsToTry) {
        const contentCache = new Map<string, string | null>();
        const aliasesCache = new Map<string, Promise<TsconfigPathAlias[]>>();
        const visiting = new Set<string>();
        const loadContent = async (configPath: string): Promise<string | null> => {
            if (contentCache.has(configPath)) return contentCache.get(configPath) ?? null;
            const content = await fetchRawFile(owner, repo, ref, configPath, signal);
            contentCache.set(configPath, content);
            return content;
        };

        const loadConfig = async (configPath: string, depth = 0): Promise<TsconfigPathAlias[]> => {
            if (aliasesCache.has(configPath)) return aliasesCache.get(configPath)!;
            if (visiting.has(configPath)) return [];
            visiting.add(configPath);
            const promise = (async () => {
                const content = await loadContent(configPath);
                if (!content) return [];
                const inherited: TsconfigPathAlias[] = [];
                if (depth < 5) {
                    for (const specifier of parseTsconfigExtends(content)) {
                        if (!specifier.startsWith('.')) continue;
                        const baseDir = path.posix.dirname(configPath);
                        const target = path.posix.normalize(path.posix.join(baseDir, specifier));
                        for (const candidate of [target, `${target}.json`]) {
                            if (candidate.endsWith('.json')) {
                                inherited.push(...await loadConfig(candidate, depth + 1));
                                break;
                            }
                        }
                    }
                }
                const configDir = path.posix.dirname(configPath);
                const own = parseTsconfigPathAliases(content, configDir === '.' ? '' : configDir);
                return [...inherited, ...own];
            })().finally(() => {
                visiting.delete(configPath);
            });
            aliasesCache.set(configPath, promise);
            return promise;
        };

        const rootContent = await loadContent('tsconfig.json');
        if (rootContent) addAliases(await loadConfig('tsconfig.json'));
        if (await loadContent('tsconfig.base.json')) addAliases(await loadConfig('tsconfig.base.json'));

        const shouldDiscoverPackages = !rootContent || rootContent.includes('"references"') || aliases.length === 0;
        let configPaths: string[] = [];
        if (shouldDiscoverPackages) {
            configPaths = await fetchTsconfigPaths(owner, repo, ref, signal);
            const packageConfigs = configPaths
                .filter((configPath) => configPath !== 'tsconfig.json' && configPath !== 'tsconfig.base.json')
                .slice(0, 8);
            const loaded = await Promise.all(packageConfigs.map((configPath) => loadConfig(configPath)));
            for (const parsed of loaded) addAliases(parsed);
        }
        // If main/master was requested but the branch does not exist, continue
        // to the next ref. Returning immediately here made master-only repos
        // silently lose all tsconfig aliases.
        if (rootContent !== null || aliases.length > 0 || configPaths.length > 0) {
            return aliases;
        }
    }
    return aliases;
}

const tsconfigAliasCache = new Map<string, Promise<TsconfigPathAlias[]>>();

function loadTsconfigAliases(
    owner: string,
    repo: string,
    refsToTry: string[],
    signal?: AbortSignal
): Promise<TsconfigPathAlias[]> {
    const cacheKey = `${owner}/${repo}@${refsToTry.join(',')}`;
    const cached = tsconfigAliasCache.get(cacheKey);
    if (cached) return cached;
    const promise = loadTsconfigAliasesUncached(owner, repo, refsToTry, signal);
    tsconfigAliasCache.set(cacheKey, promise);
    return promise;
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    task: (item: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await task(items[index]!);
        }
    });
    await Promise.all(workers);
    return results;
}

async function analyzeFileContent(
    content: string,
    filePath: string,
    symbol: string,
    kind?: CodeSymbolKind
): Promise<{ found: CodeSymbolDefinition[]; callSites: CodeSymbolCallSite[]; binding: CodeSymbolDefinition | null }> {
    const language = detectCodeLanguage(filePath);
    const cacheKey = `${hashContent(content)}|${filePath}|${symbol}|${kind ?? ''}`;
    const cached = fileAnalysisCache.get(cacheKey);
    if (cached) return cached;

    const analysis = await analyzeWithTreeSitter(content, filePath, language, symbol, kind);
    let found = analysis?.definitions.length ? analysis.definitions : extractCodeDefinitions(content, filePath, symbol, kind);
    if (found.length > 0) {
        const typeInfo = inferTypeInfo(content, filePath, symbol);
        if (typeInfo) found = found.map((definition) => ({ ...definition, typeInfo }));
    }
    const result = {
        found,
        callSites: analysis?.callSites ?? [],
        binding: found.length === 0 ? findReExportBinding(content, filePath, symbol) : null
    };
    fileAnalysisCache.set(cacheKey, result);
    return result;
}

export async function findCodeSymbol(input: CodeSymbolInput): Promise<CodeSymbolResult> {
    const parsed = parseGitHubRepoSpec(input.repo);
    if (!parsed) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: `Invalid GitHub repository: ${input.repo}. Use owner/repo or a github.com URL.`
        });
    }

    const symbol = input.symbol.trim();
    if (!symbol || /[^\w$.-]/.test(symbol)) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: 'symbol must be a single identifier (letters, digits, _, $, ., -).'
        });
    }

    const maxResults = Math.min(Math.max(input.maxResults ?? 5, 1), 10);
    const resultCacheKey = `${parsed.owner}/${parsed.repo}@${input.ref ?? 'default'}|${symbol}|${input.kind ?? ''}|${maxResults}`;
    const cachedResult = symbolResultCache.get(resultCacheKey);
    if (cachedResult) {
        return { ...cachedResult, cached: true };
    }

    const budgetMs = getNumber('CODE_SYMBOL_BUDGET_MS', 8000, { min: 3000, max: 30000, integer: true });
    const deadline = Date.now() + budgetMs;
    let partial = false;
    const debug = getBoolean('CODE_SYMBOL_DEBUG', false);
    const debugStarted = Date.now();
    const debugLog = (stage: string): void => {
        if (debug) console.error(`[codeSymbol] ${stage} +${Date.now() - debugStarted}ms`);
    };
    debugLog('start');
    const paths = await searchGitHubCode(parsed.owner, parsed.repo, symbol, maxResults, input.signal);
    debugLog(`search paths=${paths.length}`);
    const refsToTry = input.ref ? [input.ref] : ['main', 'master'];
    let aliases: TsconfigPathAlias[] = [];
    let aliasesPromise: Promise<TsconfigPathAlias[]> | null = null;
    const ensureAliases = async (): Promise<TsconfigPathAlias[]> => {
        if (!aliasesPromise) {
            aliasesPromise = loadTsconfigAliases(parsed.owner, parsed.repo, refsToTry, input.signal);
        }
        aliases = await aliasesPromise;
        return aliases;
    };
    const warnings: string[] = [];
    const definitions: CodeSymbolDefinition[] = [];
    const references: CodeSymbolReference[] = [];
    const callSites: CodeSymbolCallSite[] = [];
    let filesScanned = 0;

    type WorkItem = { path: string; via?: string; depth: number };
    const directQueue: WorkItem[] = paths.slice(0, 12).map((filePath) => ({ path: filePath, depth: 0 }));
    const reexportQueue: WorkItem[] = [];
    const visited = new Set<string>();
    const fetchWithRefs = async (filePath: string): Promise<string | null> => {
        const contentKey = `${parsed.owner}/${parsed.repo}/${refsToTry[0] ?? 'HEAD'}/${filePath}`;
        const cached = fileContentCache.get(contentKey);
        if (cached !== null) return cached;
        for (const ref of refsToTry) {
            const content = await fetchRawFile(parsed.owner, parsed.repo, ref, filePath, input.signal);
            if (content !== null) {
                fileContentCache.set(contentKey, content);
                return content;
            }
        }
        return null;
    };
    const directContents = new Map<string, string | null>();
    await mapWithConcurrency(directQueue, 4, async (item) => {
        directContents.set(item.path, await fetchWithRefs(item.path));
    });
    debugLog('direct fetch complete');

    const precomputed = new Map<string, Awaited<ReturnType<typeof analyzeFileContent>>>();
    const precomputable = directQueue.filter((item) => (directContents.get(item.path) ?? null) !== null);
    await mapWithConcurrency(precomputable, 3, async (item) => {
        const content = directContents.get(item.path);
        if (content) {
            precomputed.set(item.path, await analyzeFileContent(content, item.path, symbol, input.kind));
        }
    });
    debugLog('direct analysis complete');

    while ((directQueue.length > 0 || reexportQueue.length > 0) && filesScanned < 18) {
        // Direct files were already fetched/analyzed in parallel. Process those
        // cached analyses even after the soft deadline so a budget expiry returns
        // partial definitions instead of an empty result.
        const nextItem = directQueue[0] ?? reexportQueue[0]!;
        if (Date.now() > deadline && !precomputed.has(nextItem.path)) {
            partial = true;
            warnings.push(`Stopped at the ${budgetMs}ms codeSymbol budget; results are partial.`);
            break;
        }
        // Scan every direct code-search hit before spending budget on barrels.
        const item = directQueue.shift() ?? reexportQueue.shift()!;
        if (visited.has(item.path)) continue;
        visited.add(item.path);

        const content = directContents.has(item.path)
            ? directContents.get(item.path) ?? null
            : await fetchWithRefs(item.path);
        if (content === null) {
            warnings.push(`Could not fetch ${item.path}.`);
            continue;
        }
        filesScanned += 1;
        const analyzed = precomputed.get(item.path)
            ?? await analyzeFileContent(content, item.path, symbol, input.kind);
        const found = analyzed.found.map((definition) => item.via ? { ...definition, via: item.via } : definition);
        if (found.length > 0) {
            definitions.push(...found);
        } else if (analyzed.binding && isKindCompatible(analyzed.binding.kind, input.kind)) {
            definitions.push(item.via ? { ...analyzed.binding, via: item.via } : analyzed.binding);
        } else if (item.depth < 4) {
            let targets = findReExportTargets(content, item.path, symbol, aliases);
            if (targets.length === 0 && /from\s*['"][^./][^'"]*['"]/.test(content)) {
                await ensureAliases();
                targets = findReExportTargets(content, item.path, symbol, aliases);
            }
            for (const target of targets.slice(0, 4)) {
                if (!visited.has(target)) {
                    reexportQueue.push({ path: target, via: item.path, depth: item.depth + 1 });
                }
            }
        }

        if (analyzed.callSites.length > 0) {
            callSites.push(...analyzed.callSites);
        }

        const lines = content.split(/\r?\n/);
        const mentionLines = lines
            .map((line, index) => ({ line, index: index + 1 }))
            .filter(({ line }) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(line))
            .map(({ index }) => index)
            .filter((lineNumber) => !found.some((definition) =>
                lineNumber >= definition.startLine && lineNumber <= definition.endLine));
        if (mentionLines.length > 0) {
            references.push({ path: item.path, lines: mentionLines.slice(0, 20) });
        }
    }

    if (definitions.length === 0) {
        warnings.push('No declaration matched. Try a different kind or pass the exact symbol name.');
    } else if (definitions.some((definition) => definition.via)) {
        warnings.push('Definition was resolved through a re-export; the `via` field records the entry file.');
    }
    if (reexportQueue.length > 0) {
        warnings.push(`Stopped after scanning ${filesScanned} files; ${reexportQueue.length} re-export targets remain unscanned.`);
    }
    if (!partial && Date.now() > deadline) {
        partial = true;
        warnings.push(`CodeSymbol exceeded its ${budgetMs}ms soft budget.`);
    }
    debugLog('scan complete');

    const result: CodeSymbolResult = {
        repo: `${parsed.owner}/${parsed.repo}`,
        symbol,
        ref: input.ref ?? (paths.length > 0 ? 'default branch' : 'unknown'),
        definitions: definitions.slice(0, maxResults),
        references,
        callSites: callSites.slice(0, 30),
        filesScanned,
        warnings,
        partial
    };
    if (!partial) {
        symbolResultCache.set(resultCacheKey, result);
    }
    return result;
}
