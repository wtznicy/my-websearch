import axios from 'axios';
import type { AxiosResponse } from 'axios';
import { Buffer } from 'node:buffer';
import { config } from '../../config.js';
import { buildAxiosRequestOptions, isNetworkLayerError, requestDirectFirst, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { detectSystemProxy } from '../../utils/systemProxy.js';

// Avoid the GitHub README API here because anonymous API requests in this
// environment hit rate limits quickly; raw URLs are more stable for this tool.
const README_CANDIDATES = [
    'README.md',
    'README.mdx',
    'README.markdown',
    'README',
    'README.txt',
    'readme.md',
    'readme.mdx',
    'readme.markdown',
    'readme',
    'readme.txt'
];

const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com';
// jsDelivr mirrors GitHub repo files on a global CDN that stays reachable in
// networks where raw.githubusercontent.com DNS is polluted or blocked.
// URL shape: https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{file}
// An empty ref uses the repository's default branch.
const JSDELIVR_CDN_BASE = 'https://cdn.jsdelivr.net/gh';
const JSDELIVR_REF_CANDIDATES = ['', '@main', '@master'];

// Set GITHUB_README_CDN_FIRST=true to skip raw.githubusercontent.com and go
// straight to the jsDelivr CDN (useful when GitHub is unreachable).
const cdnFirst = process.env.GITHUB_README_CDN_FIRST === 'true';

// raw.githubusercontent.com 直连可达性探测：3s 超时、失败重试 1 次、结果缓存 5 分钟。
// 探测结果决定 raw 路径走直连还是走代理/jsDelivr（避免国内无代理环境每次抓取都挂满超时）。
const RAW_PROBE_TIMEOUT_MS = 3000;
const RAW_PROBE_MAX_RETRIES = 1;
const RAW_PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
const RAW_PROBE_TARGET = `${RAW_GITHUB_BASE}/`;

let rawProbeCache: { reachable: boolean; checkedAt: number } | null = null;
let rawProbePromise: Promise<boolean> | null = null;

/**
 * 探测 raw.githubusercontent.com 直连是否可达。
 * 裸 axios 请求固定 URL：不经过 buildAxiosRequestOptions（其代理路由会干扰"直连探测"语义）；
 * 任何 HTTP 响应（含 404/403/429）都说明链路可达，只有网络层失败（超时/连接拒绝/DNS）才算不可达。
 * 结果（含不可达）缓存 5 分钟，避免同一会话内多次抓取 README 反复探测；
 * 并发请求共享同一个 in-flight 探测（不重复探测）。
 */
async function isRawDirectlyReachable(): Promise<boolean> {
    const now = Date.now();
    if (rawProbeCache && now - rawProbeCache.checkedAt < RAW_PROBE_CACHE_TTL_MS) {
        return rawProbeCache.reachable;
    }
    if (rawProbePromise) {
        return rawProbePromise;
    }

    rawProbePromise = (async () => {
        let reachable = false;
        for (let attempt = 0; attempt <= RAW_PROBE_MAX_RETRIES && !reachable; attempt += 1) {
            try {
                await axios.get(RAW_PROBE_TARGET, {
                    headers: { 'User-Agent': 'GitHub-README-Fetcher/1.0' },
                    timeout: RAW_PROBE_TIMEOUT_MS,
                    validateStatus: () => true
                });
                reachable = true;
            } catch {
                // 网络层失败：重试或判定不可达
            }
        }

        rawProbeCache = { reachable, checkedAt: Date.now() };
        return reachable;
    })().finally(() => {
        rawProbePromise = null;
    });

    return rawProbePromise;
}

type ReadmeFetchOutcome =
    | { status: 'ok'; content: string }
    | { status: 'notfound' }
    | { status: 'error'; message: string };

/** 构造 README 抓取请求选项；forceDirect=true 时直连（raw 直连额外用可信 host 语义） */
function buildReadmeOptions(label: string, forceDirect: boolean, timeout: number) {
    return {
        ...buildAxiosRequestOptions({
            headers: {
                'User-Agent': 'GitHub-README-Fetcher/1.0'
            },
            trustedStaticHost: label === 'raw' && forceDirect,
            forceDirect,
            timeout,
            responseType: 'text',
            validateStatus: (status) => status === 200 || status === 404
        })
    };
}

/**
 * jsDelivr CDN 抓取：直连优先、代理兜底（requestDirectFirst）。
 * jsDelivr 是 raw 失败后的最后兜底，冷启动/并发时偶发超时（ECONNABORTED 实测），
 * 网络层错误重试 1 次；HTTP 状态错误（404/5xx）不重试。
 */
async function fetchJsDelivr(url: string, timeout: number): Promise<AxiosResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            return await requestDirectFirst('GET', url, (forceDirect) => buildReadmeOptions('jsDelivr', forceDirect, timeout), 'jsDelivr CDN');
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            if (!isNetworkLayerError(message)) {
                throw error;
            }
            console.warn(`jsDelivr network-layer failure (attempt ${attempt + 1}/2), retrying: ${message}`);
        }
    }
    throw lastError;
}

/**
 * Fetch one README candidate URL and classify the outcome.
 * @param url Candidate URL to fetch
 * @param label Source label for logs ('raw' or 'jsDelivr')
 * @param timeout Request timeout in ms
 */
async function fetchReadmeSource(url: string, label: string, timeout: number): Promise<ReadmeFetchOutcome> {
    try {
        console.error(`Fetching README from ${label}: ${url}`);

        // raw：先探测直连可达性——
        // 直连可达 → 直连（可信 host，绕过 DNS 私网过滤，避免 100.64.0.0/10 误判为 SSRF）；
        // 直连不可达但配置了代理 → raw 走代理（代理通常可通 GitHub）；
        // 直连不可达且无代理 → 返回错误，由主循环转 jsDelivr CDN 兜底。
        // jsDelivr CDN：直连优先、代理兜底（CDN 国内直连可达，代理不可达时不卡死），SSRF 防护保留。
        let response: AxiosResponse;
        if (label === 'raw') {
            if (await isRawDirectlyReachable()) {
                response = await requestWithSafeRedirects('GET', url, buildReadmeOptions('raw', true, timeout), 'raw.githubusercontent.com');
            } else if ((config.useProxy && config.proxyUrl) || (await detectSystemProxy())) {
                response = await requestWithSafeRedirects('GET', url, buildReadmeOptions('raw', false, timeout), 'raw.githubusercontent.com (proxy)');
            } else {
                return { status: 'error', message: 'raw.githubusercontent.com is unreachable from the current network without a proxy' };
            }
        } else {
            response = await fetchJsDelivr(url, timeout);
        }

        if (response.status === 404) {
            return { status: 'notfound' };
        }

        if (typeof response.data === 'string' && response.data.trim()) {
            return { status: 'ok', content: response.data };
        }

        return { status: 'error', message: 'Empty or invalid README content' };
    } catch (error: any) {
        const isTimeout = error?.code === 'ECONNABORTED';
        const status = typeof error?.response?.status === 'number' ? error.response.status : undefined;
        const message = error instanceof Error ? error.message : String(error);

        if (isTimeout) {
            console.error(`Timeout fetching README from ${label}: ${url}`);
        } else if (status !== undefined) {
            console.error(`Failed to fetch README from ${label}: ${url} (HTTP ${status}):`, message);
        } else {
            console.error(`Network error fetching README from ${label}: ${url}:`, message);
        }

        return { status: 'error', message };
    }
}

/**
 * GitHub README Fetcher - Extract repo info from URLs and fetch README content
 */

/** 仓库托管平台：github（raw + jsDelivr 双路径）或 gitee（官方 API，国内直连无需代理） */
type RepoHost = 'github' | 'gitee';

/**
 * Extract owner and repo name from GitHub/Gitee URLs
 * Supports HTTPS, SSH, and URLs with query params/fragments
 * @param url Repository URL
 * @returns {owner, repo, host} object or null if invalid
 */
function extractOwnerAndRepo(url: string): { owner: string; repo: string; host: RepoHost } | null {
    try {
        const trimmedUrl = url.trim();

        // Regex patterns for HTTPS and SSH URLs on GitHub and Gitee
        const patterns: Array<{ host: RepoHost; pattern: RegExp }> = [
            { host: 'github', pattern: /(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)/i },
            { host: 'gitee', pattern: /(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)/i },
            { host: 'github', pattern: /git@github\.com:([^\/\s]+)\/([^\/\s]+)\.git/i },
            { host: 'gitee', pattern: /git@gitee\.com:([^\/\s]+)\/([^\/\s]+)\.git/i }
        ];

        for (const { host, pattern } of patterns) {
            const match = trimmedUrl.match(pattern);
            if (match) {
                const [, owner, rawRepo] = match;

                // Clean repo name: remove query params, fragments, .git suffix, paths
                const repo = rawRepo.replace(/(?:[?#].*$|\.git$|\/.*$)/g, '');
                if (owner && repo && owner.length > 0 && repo.length > 0) {
                    return { owner: owner.trim(), repo: repo.trim(), host };
                }
            }
        }

        return null;
    } catch (error) {
        console.warn('Failed to parse repository URL:', url, error);
        return null;
    }
}

/**
 * 通过 gitee 官方 API 获取默认分支 README（公开仓库免 token）。
 * API: GET /api/v5/repos/{owner}/{repo}/readme → { content: base64 }
 * gitee 国内直连无需代理；相比 raw 路径无需猜测默认分支/文件名。
 */
async function fetchGiteeReadme(owner: string, repo: string): Promise<ReadmeFetchOutcome> {
    try {
        console.error(`Fetching README from gitee API: ${owner}/${repo}`);
        const response = await requestWithSafeRedirects('GET',
            `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
            {
                ...buildAxiosRequestOptions({
                    headers: {
                        'User-Agent': 'GitHub-README-Fetcher/1.0',
                        'Accept': 'application/json'
                    },
                    timeout: 10000,
                    responseType: 'json',
                    validateStatus: (status) => status === 200 || status === 404
                })
            }, 'gitee readme API');

        if (response.status === 404) {
            return { status: 'notfound' };
        }
        const content = (response.data as { content?: string })?.content;
        if (typeof content === 'string' && content) {
            return { status: 'ok', content: Buffer.from(content, 'base64').toString('utf8') };
        }
        return { status: 'error', message: 'Empty or invalid README content from gitee API' };
    } catch (error: any) {
        const status = typeof error?.response?.status === 'number' ? error.response.status : undefined;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to fetch README from gitee API: ${owner}/${repo}${status !== undefined ? ` (HTTP ${status})` : ''}:`, message);
        return { status: 'error', message };
    }
}

/**
 * Fetch README content from a repository
 * @param owner Repository owner (username or org)
 * @param repo Repository name
 * @param host Repository hosting platform ('github' or 'gitee')
 * @returns README content string or null if failed
 */
async function fetchReadme(owner: string, repo: string, host: RepoHost): Promise<string | null> {
    if (!owner?.trim() || !repo?.trim()) {
        console.error('Invalid owner or repo name provided');
        return null;
    }

    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());

    // gitee：官方 API 一次拿到默认分支 README（免代理、免猜文件名/分支）
    if (host === 'gitee') {
        const giteeResult = await fetchGiteeReadme(owner.trim(), repo.trim());
        if (giteeResult.status === 'ok') {
            return giteeResult.content;
        }
        console.warn(giteeResult.status === 'notfound'
            ? `README not found for ${owner.trim()}/${repo.trim()} (gitee)`
            : `Failed to fetch README for ${owner.trim()}/${repo.trim()} (gitee): ${giteeResult.message}`);
        return null;
    }

    // github：raw.githubusercontent.com + jsDelivr CDN 双路径
    let rawUnreachable = false;
    let sawFetchFailure = false;

    for (const readmeFile of README_CANDIDATES) {
        // 1) Try raw.githubusercontent.com first, unless CDN-first is forced or
        //    a previous candidate proved the raw host unreachable.
        if (!cdnFirst && !rawUnreachable) {
            const rawUrl = `${RAW_GITHUB_BASE}/${ownerEnc}/${repoEnc}/HEAD/${readmeFile}`;
            const rawResult = await fetchReadmeSource(rawUrl, 'raw', 10000);

            if (rawResult.status === 'ok') {
                return rawResult.content;
            }
            if (rawResult.status === 'error') {
                sawFetchFailure = true;
                // Domain-level failure: later candidates should not retry the raw host.
                rawUnreachable = true;
            }
        }

        // 2) Fall back to the jsDelivr CDN mirror (default branch, then main/master).
        for (const ref of JSDELIVR_REF_CANDIDATES) {
            const cdnUrl = `${JSDELIVR_CDN_BASE}/${ownerEnc}/${repoEnc}${ref}/${readmeFile}`;
            const cdnResult = await fetchReadmeSource(cdnUrl, 'jsDelivr', 10000);

            if (cdnResult.status === 'ok') {
                return cdnResult.content;
            }
            if (cdnResult.status === 'error') {
                sawFetchFailure = true;
            }
        }
    }

    if (sawFetchFailure) {
        // 所有候选源都出现非 404 错误（网络不可达/上游错误）：抛明确错误，
        // 避免调用方把"网络不通"误报为"README not found"
        throw new Error(
            `Failed to fetch README for ${owner}/${repo}: all sources (raw.githubusercontent.com, proxy, jsDelivr CDN) failed — network unreachable or upstream error. Check network/proxy configuration.`
        );
    }
    console.warn(`README not found for ${owner}/${repo}`);

    return null;
}

/**
 * Main function: parse URL and fetch README content
 * @param githubUrl GitHub repository URL
 * @returns README content or null if failed
 */
async function getReadmeFromUrl(githubUrl: string): Promise<string | null> {
    console.error(`\n--- Processing URL: ${githubUrl} ---`);

    if (!githubUrl?.trim()) {
        console.error('Invalid URL provided');
        return null;
    }

    const repoInfo = extractOwnerAndRepo(githubUrl);

    if (!repoInfo) {
        console.error(`Unable to extract owner and repo from URL: ${githubUrl}`);
        return null;
    }

    console.error(`✅ Extraction successful: ${repoInfo.owner}/${repoInfo.repo} (${repoInfo.host})`);

    const content = await fetchReadme(repoInfo.owner, repoInfo.repo, repoInfo.host);

    if (content) {
        console.error(`✅ README fetched successfully (${content.length} characters)`);
        return content;
    } else {
        console.warn(`❌ Failed to fetch README for ${repoInfo.owner}/${repoInfo.repo}`);
        return null;
    }
}

/**
 * Fetch README content from GitHub repository
 * @param githubUrl GitHub repository URL (supports HTTPS, SSH, with params)
 * @returns README content string or null if failed
 */
export async function fetchGithubReadme(githubUrl: string): Promise<string | null> {
    return getReadmeFromUrl(githubUrl);
}
