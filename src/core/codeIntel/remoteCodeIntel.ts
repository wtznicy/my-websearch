import { AppError } from '../errors.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';
import path from 'node:path';

export type CodeSymbolKind = 'class' | 'function' | 'interface' | 'type' | 'method' | 'const' | 'enum' | 'struct' | 'trait';

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
    filesScanned: number;
    warnings: string[];
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
            return [
                { kind: 'function', pattern: new RegExp(`\\b${name}\\s*\\(`) },
                { kind: 'class', pattern: new RegExp(`\\b(?:class|struct|interface)\\s+${name}\\b`) }
            ];
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

function resolveModuleCandidates(filePath: string, specifier: string): string[] {
    if (!specifier.startsWith('.')) return [];
    const base = path.posix.dirname(filePath);
    const target = path.posix.normalize(path.posix.join(base, specifier));
    const withoutExtension = target.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx)$/i, '');
    const candidates = new Set<string>([target]);
    for (const extension of ['.ts', '.tsx', '.d.ts', '.js', '.jsx']) {
        candidates.add(`${withoutExtension}${extension}`);
        candidates.add(path.posix.join(withoutExtension, `index${extension}`));
    }
    return [...candidates];
}

/** Resolve `export { X } from './module'` / `export * from './module'` targets. */
export function findReExportTargets(content: string, filePath: string, symbol: string): string[] {
    const targets: string[] = [];
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const named = line.match(/^\s*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);
        if (named?.[1] && named[2]) {
            const names = named[1].split(',').map((item) => item.trim()).filter(Boolean);
            const matches = names.some((item) => {
                const [imported, exported] = item.split(/\s+as\s+/).map((part) => part.trim());
                return imported === symbol || exported === symbol;
            });
            if (matches) targets.push(...resolveModuleCandidates(filePath, named[2]));
            continue;
        }
        const star = line.match(/^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/);
        if (star?.[1]) {
            targets.push(...resolveModuleCandidates(filePath, star[1]));
        }
    }
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
    const patterns = declarationPatterns(language, symbol).filter(({ kind: declaredKind }) => !kind || declaredKind === kind);
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
    const token = process.env.GITHUB_TOKEN?.trim();
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
    const token = process.env.GITHUB_TOKEN?.trim();
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
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${Math.min(Math.max(maxResults * 3, 10), 50)}`;
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
    return [...new Set((data.items ?? [])
        .map((item) => item.path)
        .filter((path): path is string => Boolean(path))
    )];
}

async function fetchRawFile(
    owner: string,
    repo: string,
    ref: string,
    path: string,
    signal?: AbortSignal
): Promise<string | null> {
    for (const url of buildRawFileUrls(owner, repo, ref, path)) {
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
    return null;
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
    const paths = await searchGitHubCode(parsed.owner, parsed.repo, symbol, maxResults, input.signal);
    const refsToTry = input.ref ? [input.ref] : ['main', 'master'];
    const warnings: string[] = [];
    const definitions: CodeSymbolDefinition[] = [];
    const references: CodeSymbolReference[] = [];
    let filesScanned = 0;

    type WorkItem = { path: string; via?: string; depth: number };
    const queue: WorkItem[] = paths.slice(0, 8).map((filePath) => ({ path: filePath, depth: 0 }));
    const visited = new Set<string>();

    while (queue.length > 0 && filesScanned < 12) {
        const item = queue.shift()!;
        if (visited.has(item.path)) continue;
        visited.add(item.path);

        let content: string | null = null;
        for (const ref of refsToTry) {
            content = await fetchRawFile(parsed.owner, parsed.repo, ref, item.path, input.signal);
            if (content !== null) {
                break;
            }
        }
        if (content === null) {
            warnings.push(`Could not fetch ${item.path}.`);
            continue;
        }
        filesScanned += 1;
        const found = extractCodeDefinitions(content, item.path, symbol, input.kind)
            .map((definition) => item.via ? { ...definition, via: item.via } : definition);
        definitions.push(...found);

        if (found.length === 0 && item.depth < 2) {
            const targets = findReExportTargets(content, item.path, symbol);
            for (const target of targets.slice(0, 4)) {
                if (!visited.has(target)) {
                    queue.push({ path: target, via: item.path, depth: item.depth + 1 });
                }
            }
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

    return {
        repo: `${parsed.owner}/${parsed.repo}`,
        symbol,
        ref: input.ref ?? (paths.length > 0 ? 'default branch' : 'unknown'),
        definitions: definitions.slice(0, maxResults),
        references,
        filesScanned,
        warnings
    };
}
