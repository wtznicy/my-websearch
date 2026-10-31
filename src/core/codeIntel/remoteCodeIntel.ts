import { AppError } from '../errors.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';

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
    for (let index = startIndex; index < Math.min(lines.length, startIndex + 200); index += 1) {
        for (const char of lines[index] ?? '') {
            if (char === '{') {
                depth += 1;
                seenBrace = true;
            } else if (char === '}') {
                depth -= 1;
            }
        }
        if (seenBrace && depth <= 0) {
            return index;
        }
    }
    return Math.min(lines.length - 1, startIndex + 40);
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
            const endIndex = language === 'python'
                ? pythonBlockEndLine(lines, index)
                : braceEndLine(lines, index);
            definitions.push({
                path: filePath,
                language,
                kind: declaredKind,
                signature: line.trim().slice(0, 300),
                startLine: index + 1,
                endLine: endIndex + 1,
                code: lines.slice(index, Math.min(endIndex + 1, index + 60)).join('\n').slice(0, 8000)
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
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodedPath}`;
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
            'GitHub raw file'
        );
        return response.status === 200 && typeof response.data === 'string' ? response.data : null;
    } catch {
        return null;
    }
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

    for (const path of paths.slice(0, 8)) {
        let content: string | null = null;
        for (const ref of refsToTry) {
            content = await fetchRawFile(parsed.owner, parsed.repo, ref, path, input.signal);
            if (content !== null) {
                break;
            }
        }
        if (content === null) {
            warnings.push(`Could not fetch ${path}.`);
            continue;
        }
        filesScanned += 1;
        const found = extractCodeDefinitions(content, path, symbol, input.kind);
        definitions.push(...found);

        const lines = content.split(/\r?\n/);
        const mentionLines = lines
            .map((line, index) => ({ line, index: index + 1 }))
            .filter(({ line }) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(line))
            .map(({ index }) => index)
            .filter((lineNumber) => !found.some((definition) =>
                lineNumber >= definition.startLine && lineNumber <= definition.endLine));
        if (mentionLines.length > 0) {
            references.push({ path, lines: mentionLines.slice(0, 20) });
        }
    }

    if (definitions.length === 0) {
        warnings.push('No declaration matched. Try a different kind or pass the exact symbol name.');
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
