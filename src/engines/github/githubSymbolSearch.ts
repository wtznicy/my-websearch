import axios, { AxiosResponse } from 'axios';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { AppError } from '../../core/errors.js';
import { getOptionalString } from '../../config/env.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { parseGitHubRepoSpec } from './githubSearch.js';

export interface SearchGithubSymbolOptions {
    urlOrRepo: string;
    symbol: string;
    ref?: string;
    maxResults?: number;
    signal?: AbortSignal;
}

export type SymbolKind =
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'struct'
    | 'trait'
    | 'macro'
    | 'variable'
    | 'constant'
    | 'definition'
    | 'reference';

export interface SymbolMatchItem {
    kind: SymbolKind;
    file: string;
    line: number;
    snippet: string;
    isDefinition: boolean;
}

export interface GithubSymbolSearchResult {
    owner: string;
    repo: string;
    ref: string;
    symbol: string;
    mode: 'syntactic';
    scannedFiles: number;
    totalFiles: number;
    truncated: boolean;
    definitions: SymbolMatchItem[];
    references: SymbolMatchItem[];
    warnings: string[];
    rateLimitRemaining?: number;
}

const MAX_ARCHIVE_BYTES = 30 * 1024 * 1024; // 30MB 压缩包流上限（FastAPI 约 18MB，主流库与框架均覆盖）
const MAX_DECOMPRESSED_BYTES = 90 * 1024 * 1024; // 90MB 解压文本总上限（源码以外的文档/图片也在 tar 内）
const MAX_SINGLE_FILE_BYTES = 300 * 1024; // 300KB 单文件源码上限
const SYMBOL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟缓存

interface CacheEntry {
    result: GithubSymbolSearchResult;
    cachedAt: number;
}

const symbolResultCache = new Map<string, CacheEntry>();

export function __resetGithubSymbolCacheForTests(): void {
    symbolResultCache.clear();
}

/**
 * 语言分类定义及支持的文件后缀
 */
type LanguageCategory =
    | 'js_ts'
    | 'go'
    | 'python'
    | 'rust'
    | 'jvm_dotnet'
    | 'c_cpp'
    | 'ruby'
    | 'php'
    | 'swift';

const EXTENSION_TO_CATEGORY: Record<string, LanguageCategory> = {
    '.ts': 'js_ts',
    '.tsx': 'js_ts',
    '.js': 'js_ts',
    '.jsx': 'js_ts',
    '.mjs': 'js_ts',
    '.cjs': 'js_ts',
    '.go': 'go',
    '.py': 'python',
    '.rs': 'rust',
    '.java': 'jvm_dotnet',
    '.cs': 'jvm_dotnet',
    '.kt': 'jvm_dotnet',
    '.scala': 'jvm_dotnet',
    '.c': 'c_cpp',
    '.cpp': 'c_cpp',
    '.cc': 'c_cpp',
    '.cxx': 'c_cpp',
    '.h': 'c_cpp',
    '.hpp': 'c_cpp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift'
};

const NOISE_PATH_PATTERN = /(?:^|\/)(?:test|tests|__tests__|testing|mocks?|vendor|node_modules|dist|build|target|generated|\.git)(?:\/|$)|(?:_test\.[a-z0-9]+|\.test\.[a-z0-9]+|\.spec\.[a-z0-9]+|test_[^/]+\.py)$/i;
const BINARY_OR_IGNORE_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
    '.zip', '.tar', '.gz', '.tgz', '.wasm', '.bin', '.exe',
    '.pdf', '.lock', '.min.js', '.min.css', '.map'
]);

function getLanguageCategory(filePath: string): LanguageCategory | null {
    const extMatch = filePath.match(/\.[A-Za-z0-9]+$/);
    if (!extMatch) return null;
    const ext = extMatch[0].toLowerCase();
    return EXTENSION_TO_CATEGORY[ext] ?? null;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface DefinitionRule {
    kind: SymbolKind;
    regex: RegExp;
}

function buildDefinitionRules(safeSymbol: string): Record<LanguageCategory, DefinitionRule[]> {
    return {
        js_ts: [
            { kind: 'function', regex: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\*?\\s+${safeSymbol}\\b`) },
            { kind: 'class', regex: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${safeSymbol}\\b`) },
            { kind: 'interface', regex: new RegExp(`^\\s*(?:export\\s+)?interface\\s+${safeSymbol}\\b`) },
            { kind: 'type', regex: new RegExp(`^\\s*(?:export\\s+)?type\\s+${safeSymbol}\\b`) },
            { kind: 'variable', regex: new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${safeSymbol}\\s*[:=]`) }
        ],
        go: [
            // 支持普通函数、带接收者函数 func (r *Receiver) Sym、以及泛型函数 func Sym[T any](
            { kind: 'function', regex: new RegExp(`^\\s*func\\s+(?:\\([^)]+\\)\\s+)?${safeSymbol}(?:\\[[^\\]]+\\])?\\s*[(<]`) },
            // 支持 type Sym struct / interface / alias / generic
            { kind: 'type', regex: new RegExp(`^\\s*type\\s+${safeSymbol}(?:\\[[^\\]]+\\])?\\s+(?:struct|interface|=|type|\\b)`) },
            { kind: 'constant', regex: new RegExp(`^\\s*(?:const|var)\\s+${safeSymbol}\\b`) }
        ],
        python: [
            { kind: 'function', regex: new RegExp(`^\\s*(?:async\\s+)?def\\s+${safeSymbol}\\s*\\(`) },
            { kind: 'class', regex: new RegExp(`^\\s*class\\s+${safeSymbol}\\s*[:(]`) },
            { kind: 'variable', regex: new RegExp(`^\\s*${safeSymbol}\\s*[:=]`) }
        ],
        rust: [
            { kind: 'function', regex: new RegExp(`^\\s*(?:pub(?:\\([^)]+\\))?\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]+"\\s+)?fn\\s+${safeSymbol}\\b`) },
            { kind: 'struct', regex: new RegExp(`^\\s*(?:pub(?:\\([^)]+\\))?\\s+)?(?:struct|enum|union)\\s+${safeSymbol}\\b`) },
            { kind: 'trait', regex: new RegExp(`^\\s*(?:pub(?:\\([^)]+\\))?\\s+)?trait\\s+${safeSymbol}\\b`) },
            { kind: 'type', regex: new RegExp(`^\\s*(?:pub(?:\\([^)]+\\))?\\s+)?type\\s+${safeSymbol}\\b`) },
            { kind: 'macro', regex: new RegExp(`^\\s*(?:doc!\\s*\\{\\s*)?macro_rules!\\s+${safeSymbol}\\b`) }
        ],
        jvm_dotnet: [
            { kind: 'class', regex: new RegExp(`^\\s*(?:public|protected|private|static|final|abstract|sealed|internal|open|data|case)*\\s*(?:class|interface|enum|record|struct|object|trait)\\s+${safeSymbol}\\b`) },
            { kind: 'function', regex: new RegExp(`^\\s*(?:public|protected|private|static|final|abstract|override|virtual|async|fun|def)*\\s*(?:[\\w<>\\[\\],?]+(?:\\s+|\\s*\\*|\\s*&))?${safeSymbol}\\s*\\(`) }
        ],
        c_cpp: [
            { kind: 'class', regex: new RegExp(`^\\s*(?:class|struct|enum(?:\\s+class)?|union)\\s+(?:[A-Za-z0-9_]+_API\\s+)?${safeSymbol}\\b`) },
            { kind: 'function', regex: new RegExp(`^\\s*(?:[\\w:<>\\[\\]*&]+\\s+)+${safeSymbol}\\s*\\(`) }
        ],
        ruby: [
            { kind: 'function', regex: new RegExp(`^\\s*def\\s+(?:self\\.)?${safeSymbol}\\b`) },
            { kind: 'class', regex: new RegExp(`^\\s*(?:class|module)\\s+${safeSymbol}\\b`) }
        ],
        php: [
            { kind: 'function', regex: new RegExp(`^\\s*(?:public|protected|private|static|final|abstract)*\\s*function\\s+${safeSymbol}\\s*\\(`) },
            { kind: 'class', regex: new RegExp(`^\\s*(?:final|abstract)*\\s*(?:class|interface|trait|enum)\\s+${safeSymbol}\\b`) }
        ],
        swift: [
            { kind: 'function', regex: new RegExp(`^\\s*(?:public|private|fileprivate|internal|open|static|class|override)*\\s*func\\s+${safeSymbol}\\b`) },
            { kind: 'class', regex: new RegExp(`^\\s*(?:public|private|fileprivate|internal|open)*\\s*(?:class|struct|enum|protocol|actor)\\s+${safeSymbol}\\b`) }
        ]
    };
}

function isCommentOrNoiseLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;
    return /^(?:\/\/|#|--|%|\/\*|\*|\*\/|"""|'''|\bimport\b|\bfrom\b|\bpackage\b|\buse\s+[a-z0-9_:]+;)/i.test(trimmed);
}

function extractSnippet(lines: string[], lineIndex: number, maxLines = 8): string {
    let start = lineIndex;
    // 向上探测至多 3 行文档注释
    while (start > 0 && start > lineIndex - 3) {
        const prev = lines[start - 1]!.trim();
        if (prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*') || prev.startsWith('#')) {
            start--;
        } else {
            break;
        }
    }
    const end = Math.min(lines.length - 1, lineIndex + maxLines);
    return lines.slice(start, end + 1).join('\n');
}

interface InMemorySourceFile {
    path: string;
    content: string;
}

/**
 * 流式解压 ustar 格式 tar.gz 包并筛选有效源码文件
 */
function parseTarGzStream(
    stream: Readable,
    options: {
        maxArchiveBytes: number;
        maxDecompressedBytes: number;
        maxSingleFileBytes: number;
    }
): Promise<{ files: InMemorySourceFile[]; totalFiles: number }> {
    return new Promise((resolve, reject) => {
        const gunzip = zlib.createGunzip();
        let downloadedBytes = 0;
        let decompressedBytes = 0;
        let buffer = Buffer.alloc(0);
        let nextOverrideName: string | null = null;
        let isAborted = false;
        let totalFilesCount = 0;
        const sourceFiles: InMemorySourceFile[] = [];

        function abort(err: Error) {
            if (isAborted) return;
            isAborted = true;
            try { stream.destroy(); } catch {}
            try { gunzip.destroy(); } catch {}
            reject(err);
        }

        stream.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (downloadedBytes > options.maxArchiveBytes) {
                abort(new AppError({
                    code: 'rate_limited',
                    retryable: false,
                    message: `Repository archive exceeded size limit (${Math.round(options.maxArchiveBytes / 1024 / 1024)}MB). Falling back to sampled search.`
                }));
            }
        });

        stream.pipe(gunzip);

        gunzip.on('data', (chunk: Buffer) => {
            if (isAborted) return;
            decompressedBytes += chunk.length;
            if (decompressedBytes > options.maxDecompressedBytes) {
                abort(new AppError({
                    code: 'rate_limited',
                    retryable: false,
                    message: `Decompressed repository content exceeded size limit (${Math.round(options.maxDecompressedBytes / 1024 / 1024)}MB).`
                }));
                return;
            }

            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 512) {
                const header = buffer.subarray(0, 512);
                if (header.every((b) => b === 0)) {
                    buffer = buffer.subarray(512);
                    continue;
                }

                let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
                const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
                if (prefix && !nextOverrideName) {
                    name = `${prefix}/${name}`;
                }
                if (nextOverrideName) {
                    name = nextOverrideName;
                    nextOverrideName = null;
                }

                const sizeStr = header.subarray(124, 136).toString('utf8').trim().replace(/\0.*$/, '');
                const size = parseInt(sizeStr, 8) || 0;
                const typeflag = String.fromCharCode(header[156] || 0);
                const totalBlockSize = 512 + Math.ceil(size / 512) * 512;

                if (buffer.length < totalBlockSize) {
                    break;
                }

                const content = buffer.subarray(512, 512 + size);
                buffer = buffer.subarray(totalBlockSize);

                if (typeflag === 'L') {
                    // GNU long filename block
                    nextOverrideName = content.toString('utf8').replace(/\0.*$/, '');
                    continue;
                }

                if (typeflag === '0' || typeflag === '\0') {
                    totalFilesCount++;
                    // 剥离 tar 包最外层 repo-ref 前缀（例如 gin-HEAD/gin.go -> gin.go）
                    const cleanPath = name.replace(/^[^/]+\//, '');
                    const isNoise = NOISE_PATH_PATTERN.test(cleanPath);
                    const ext = cleanPath.slice(cleanPath.lastIndexOf('.')).toLowerCase();

                    if (!isNoise && !BINARY_OR_IGNORE_EXTS.has(ext) && getLanguageCategory(cleanPath) !== null) {
                        if (size <= options.maxSingleFileBytes) {
                            sourceFiles.push({
                                path: cleanPath,
                                content: content.toString('utf8')
                            });
                        }
                    }
                }
            }
        });

        gunzip.on('end', () => {
            if (!isAborted) {
                resolve({ files: sourceFiles, totalFiles: totalFilesCount });
            }
        });

        gunzip.on('error', (err) => {
            if (!isAborted) abort(err);
        });

        stream.on('error', (err) => {
            if (!isAborted) abort(err);
        });
    });
}

/**
 * 扫描内存源码列表匹配符号定义与引用
 */
function scanFilesForSymbol(
    files: InMemorySourceFile[],
    symbol: string,
    maxResults: number
): { definitions: SymbolMatchItem[]; references: SymbolMatchItem[] } {
    const safe = escapeRegex(symbol);
    const rules = buildDefinitionRules(safe);
    const refRegex = new RegExp(`\\b${safe}\\b`);

    const definitions: SymbolMatchItem[] = [];
    const references: SymbolMatchItem[] = [];

    // 优先生产核心代码，将测试/示例/Mock 文件后置
    const sortedFiles = [...files].sort((a, b) => {
        const aTest = /test|spec|example|mock/i.test(a.path);
        const bTest = /test|spec|example|mock/i.test(b.path);
        if (aTest !== bTest) return aTest ? 1 : -1;
        return a.path.localeCompare(b.path);
    });

    for (const file of sortedFiles) {
        const category = getLanguageCategory(file.path);
        if (!category) continue;
        const defRules = rules[category] ?? [];
        const lines = file.content.split('\n');

        let inBlockComment = false;
        let blockCommentType: 'c' | 'py_triple_double' | 'py_triple_single' | null = null;

        lines.forEach((line, index) => {
            const lineNum = index + 1;
            const trimmed = line.trim();

            // 多行块注释与 docstring 状态判定
            if (inBlockComment) {
                if (blockCommentType === 'c' && trimmed.includes('*/')) {
                    inBlockComment = false;
                    blockCommentType = null;
                } else if (blockCommentType === 'py_triple_double' && trimmed.includes('"""')) {
                    inBlockComment = false;
                    blockCommentType = null;
                } else if (blockCommentType === 'py_triple_single' && trimmed.includes("'''")) {
                    inBlockComment = false;
                    blockCommentType = null;
                }
                return;
            }

            if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
                inBlockComment = true;
                blockCommentType = 'c';
                return;
            }
            if (trimmed.startsWith('"""') && trimmed.lastIndexOf('"""') === 0) {
                inBlockComment = true;
                blockCommentType = 'py_triple_double';
                return;
            }
            if (trimmed.startsWith("'''") && trimmed.lastIndexOf("'''") === 0) {
                inBlockComment = true;
                blockCommentType = 'py_triple_single';
                return;
            }

            const isComment = isCommentOrNoiseLine(line);

            // 1. 尝试匹配定义
            if (!isComment) {
                for (const rule of defRules) {
                    if (rule.regex.test(line)) {
                        definitions.push({
                            kind: rule.kind,
                            file: file.path,
                            line: lineNum,
                            snippet: extractSnippet(lines, index),
                            isDefinition: true
                        });
                        return;
                    }
                }
            }

            // 2. 若不是定义，但包含单词符号且非纯注释，计入引用
            if (!isComment && refRegex.test(line)) {
                if (references.length < 10) {
                    references.push({
                        kind: 'reference',
                        file: file.path,
                        line: lineNum,
                        snippet: line.trim(),
                        isDefinition: false
                    });
                }
            }
        });
    }

    return {
        definitions: definitions.slice(0, maxResults),
        references: references.slice(0, 10)
    };
}

/**
 * 两阶段候选文件提取与打分（用于超大仓库降级抽样）
 */
function pickCandidateFiles(filePaths: string[], symbol: string, maxLimit = 12): string[] {
    const cleanPaths = filePaths.filter((p) => {
        if (NOISE_PATH_PATTERN.test(p)) return false;
        const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
        return !BINARY_OR_IGNORE_EXTS.has(ext) && getLanguageCategory(p) !== null;
    });

    if (cleanPaths.length <= maxLimit) {
        return cleanPaths;
    }

    const symbolLower = symbol.toLowerCase();
    // 驼峰或蛇形拆词
    const subwords = symbol.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/).filter((w) => w.length >= 3);

    const scored = cleanPaths.map((path) => {
        let score = 0;
        const base = path.split('/').pop()?.toLowerCase() ?? '';
        const depth = path.split('/').length;

        // 浅层源码文件加权
        if (depth <= 2 && /^(?:src|lib|pkg|core)\b/i.test(path)) score += 50;

        // 入口文件加权
        if (/^(?:index|main|mod|lib|core|client|app)\.[a-z]+$/i.test(base)) score += 40;

        // 文件名包含完整 symbol
        if (base.includes(symbolLower)) score += 100;

        // 文件名包含子词
        for (const word of subwords) {
            if (base.includes(word)) score += 30;
        }

        return { path, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // 第一阶段：取前 70% 预算的高先验文件
    const stage1Count = Math.floor(maxLimit * 0.7);
    const topCandidates = scored.slice(0, stage1Count).map((item) => item.path);

    // 第二阶段：取 30% 分散在其它目录的文件避免漏检
    const remaining = scored.slice(stage1Count);
    const step = Math.max(1, Math.floor(remaining.length / (maxLimit - stage1Count)));
    const dispersed: string[] = [];
    for (let i = 0; i < remaining.length && topCandidates.length + dispersed.length < maxLimit; i += step) {
        dispersed.push(remaining[i]!.path);
    }

    return [...topCandidates, ...dispersed];
}

/**
 * 降级路径：获取文件树并逐个抓取扫描
 */
async function fallbackSampledSymbolSearch(
    owner: string,
    repo: string,
    ref: string,
    symbol: string,
    maxResults: number,
    signal?: AbortSignal
): Promise<GithubSymbolSearchResult> {
    const warnings: string[] = [];
    const token = getOptionalString('GITHUB_TOKEN');
    let fileList: string[] = [];
    let rateLimitRemaining: number | undefined;

    // 1. 优先尝试 GitHub Tree API（递归树）
    try {
        const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
        const treeHeaders: Record<string, string> = {
            'User-Agent': 'my-websearch-mcp/1.0',
            'Accept': 'application/vnd.github.v3+json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        };

        const res = await requestDirectFirst('GET', treeUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({ headers: treeHeaders, timeout: 8000, forceDirect, signal })
        }), 'GitHub Tree API');

        if (res.headers && res.headers['x-ratelimit-remaining']) {
            rateLimitRemaining = Number(res.headers['x-ratelimit-remaining']);
        }

        if (res.status === 200 && res.data && Array.isArray((res.data as { tree?: Array<{ path?: string; type?: string }> }).tree)) {
            const tree = (res.data as { tree: Array<{ path?: string; type?: string }> }).tree;
            fileList = tree.filter((t) => t.type === 'blob' && typeof t.path === 'string').map((t) => t.path!);
        }
    } catch (treeErr) {
        // Tree API 失败，尝试 jsDelivr flat API
        try {
            const jsdelivrUrl = `https://data.jsdelivr.com/v1/packages/gh/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}@${encodeURIComponent(ref)}?structure=flat`;
            const jdRes = await axios.get(jsdelivrUrl, { timeout: 8000, signal });
            if (jdRes.status === 200 && Array.isArray((jdRes.data as { files?: Array<{ name?: string }> }).files)) {
                fileList = (jdRes.data as { files: Array<{ name: string }> }).files.map((f) => f.name.replace(/^\//, ''));
            }
        } catch {
            warnings.push('Failed to retrieve file tree from both GitHub Tree API and jsDelivr.');
        }
    }

    if (fileList.length === 0) {
        throw new AppError({
            code: 'upstream_response_invalid',
            retryable: false,
            engine: 'github',
            message: `Could not retrieve file list for repository ${owner}/${repo}@${ref}.`,
            hint: token ? 'Check if repository exists and branch/tag is correct.' : 'Set GITHUB_TOKEN to raise anonymous rate limits.'
        });
    }

    const candidatePaths = pickCandidateFiles(fileList, symbol, 12);
    const candidateFiles: InMemorySourceFile[] = [];

    // 并发获取候选文件内容
    await Promise.all(candidatePaths.map(async (filePath) => {
        // A. 尝试 jsDelivr CDN
        const cdnUrl = `https://cdn.jsdelivr.net/gh/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}@${encodeURIComponent(ref)}/${filePath}`;
        try {
            const cdnRes = await axios.get(cdnUrl, { timeout: 5000, responseType: 'text', signal });
            if (cdnRes.status === 200 && typeof cdnRes.data === 'string') {
                candidateFiles.push({ path: filePath, content: cdnRes.data });
                return;
            }
        } catch {}

        // B. 尝试 GitHub Contents API（返回 base64）
        try {
            const contentsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}?ref=${encodeURIComponent(ref)}`;
            const cHeaders: Record<string, string> = {
                'User-Agent': 'my-websearch-mcp/1.0',
                'Accept': 'application/vnd.github.v3+json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            };
            const cRes = await requestDirectFirst('GET', contentsUrl, (forceDirect) => ({
                ...buildAxiosRequestOptions({ headers: cHeaders, timeout: 5000, forceDirect, signal })
            }), 'GitHub Contents API');

            if (cRes.headers && cRes.headers['x-ratelimit-remaining']) {
                rateLimitRemaining = Number(cRes.headers['x-ratelimit-remaining']);
            }

            if (cRes.status === 200 && cRes.data && (cRes.data as { content?: string; encoding?: string }).encoding === 'base64') {
                const b64 = (cRes.data as { content: string }).content.replace(/\s+/g, '');
                const text = Buffer.from(b64, 'base64').toString('utf8');
                candidateFiles.push({ path: filePath, content: text });
            }
        } catch {}
    }));

    const { definitions, references } = scanFilesForSymbol(candidateFiles, symbol, maxResults);

    return {
        owner,
        repo,
        ref,
        symbol,
        mode: 'syntactic',
        scannedFiles: candidateFiles.length,
        totalFiles: fileList.length,
        truncated: true,
        definitions,
        references,
        warnings,
        rateLimitRemaining
    };
}

/**
 * 核心对外入口：指定仓库/包的代码符号检索
 */
export async function searchGithubSymbol(options: SearchGithubSymbolOptions): Promise<GithubSymbolSearchResult> {
    const { urlOrRepo, symbol, ref = 'HEAD', maxResults = 5, signal } = options;

    if (!symbol?.trim()) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            engine: 'github',
            message: 'Symbol name must not be empty.'
        });
    }

    const repoSpec = parseGitHubRepoSpec(urlOrRepo);
    if (!repoSpec) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            engine: 'github',
            message: `Invalid GitHub repository target: "${urlOrRepo}". Expected owner/repo or https://github.com/owner/repo.`
        });
    }

    const { owner, repo } = repoSpec;
    const cleanRef = ref.trim() || 'HEAD';
    const cacheKey = `${owner}/${repo}@${cleanRef}:${symbol.trim()}:${maxResults}`;
    const cached = symbolResultCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < SYMBOL_CACHE_TTL_MS) {
        return cached.result;
    }

    const token = getOptionalString('GITHUB_TOKEN');
    const codeloadUrl = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${encodeURIComponent(cleanRef)}`;

    // 1. 首选主路径：codeload 全量流式拉取与扫描
    try {
        const headers: Record<string, string> = {
            'User-Agent': 'my-websearch-mcp/1.0',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        };

        const reqConfig = buildAxiosRequestOptions({
            headers,
            timeout: 30000,
            engine: 'github',
            trustedStaticHost: true,
            requestUrl: codeloadUrl,
            signal
        });
        reqConfig.responseType = 'stream';

        const response: AxiosResponse<Readable> = await axios.get(codeloadUrl, reqConfig);

        if (response.status === 200 && response.data) {
            const { files, totalFiles } = await parseTarGzStream(response.data, {
                maxArchiveBytes: MAX_ARCHIVE_BYTES,
                maxDecompressedBytes: MAX_DECOMPRESSED_BYTES,
                maxSingleFileBytes: MAX_SINGLE_FILE_BYTES
            });

            const { definitions, references } = scanFilesForSymbol(files, symbol.trim(), maxResults);

            const result: GithubSymbolSearchResult = {
                owner,
                repo,
                ref: cleanRef,
                symbol: symbol.trim(),
                mode: 'syntactic',
                scannedFiles: files.length,
                totalFiles,
                truncated: false,
                definitions,
                references,
                warnings: []
            };

            symbolResultCache.set(cacheKey, { result, cachedAt: Date.now() });
            return result;
        }
    } catch (codeloadErr) {
        // codeload 遇到 404、超大包、网络重置等，优雅降级到树抽样
        const errMsg = codeloadErr instanceof Error ? codeloadErr.message : String(codeloadErr);
        console.warn(`[GitHub Symbol] Primary codeload failed (${errMsg}), falling back to tree sampling...`);
    }

    // 2. 二级备选：Tree + 候选文件两阶段抽样
    const fallbackResult = await fallbackSampledSymbolSearch(owner, repo, cleanRef, symbol.trim(), maxResults, signal);
    if (!fallbackResult.truncated || fallbackResult.definitions.length > 0) {
        symbolResultCache.set(cacheKey, { result: fallbackResult, cachedAt: Date.now() });
    }
    return fallbackResult;
}

/**
 * 格式化符号检索结果为标准 Markdown
 */
export function formatSymbolSearchResult(result: GithubSymbolSearchResult): string {
    const lines: string[] = [];
    lines.push(`# Code Symbol Search: \`${result.symbol}\` in \`${result.owner}/${result.repo}\` (${result.ref})`);
    lines.push('');
    lines.push(`> ℹ️ Mode: **syntactic** | Scanned: **${result.scannedFiles}** source files (${result.totalFiles} total) | Definitions: **${result.definitions.length}** | References: **${result.references.length}**`);
    if (result.truncated) {
        lines.push(`> ⚠️ Large repository or quota fallback: results sampled across candidate entry & core files.`);
    }
    for (const w of result.warnings) {
        lines.push(`> ⚠️ ${w}`);
    }
    lines.push('');

    if (result.definitions.length > 0) {
        lines.push('## Definitions');
        lines.push('');
        result.definitions.forEach((def, idx) => {
            const ext = def.file.slice(def.file.lastIndexOf('.') + 1);
            lines.push(`### ${idx + 1}. \`${def.file}:${def.line}\` (${def.kind})`);
            lines.push(`\`\`\`${ext}`);
            lines.push(def.snippet);
            lines.push('```');
            lines.push('');
        });
    } else {
        lines.push('## Definitions');
        lines.push('');
        lines.push(`No direct syntactic definition found for \`${result.symbol}\` in the scanned files.`);
        lines.push('');
    }

    if (result.references.length > 0) {
        lines.push('## References');
        lines.push('');
        result.references.forEach((ref) => {
            lines.push(`- \`${ref.file}:${ref.line}\`: \`${ref.snippet.trim()}\``);
        });
        lines.push('');
    }

    return lines.join('\n').trim();
}
