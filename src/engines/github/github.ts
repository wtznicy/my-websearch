import axios from 'axios';
import type { AxiosResponse } from 'axios';
import { Buffer } from 'node:buffer';
import { config } from '../../config.js';
import { buildAxiosRequestOptions, isNetworkLayerError, requestDirectFirst, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { detectSystemProxy } from '../../utils/systemProxy.js';
import { AppError } from '../../core/errors.js';

// Avoid the GitHub README API here because anonymous API requests in this
// environment hit rate limits quickly; raw URLs are more stable for this tool.
export const README_CANDIDATES = [
    'README.md',
    'readme.md',
    'README.rst',
    'README.mdx',
    'README.markdown',
    'README',
    'README.txt'
];

const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com';
// jsDelivr mirrors GitHub repo files on a global CDN that stays reachable in
// networks where raw.githubusercontent.com DNS is polluted or blocked.
// URL shape: https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{file}
// NOTE (P0-5): An empty ref (`''`) on jsDelivr 301-redirects to the latest semver git tag
// (e.g. `tokio@0.1.5` from 2018) instead of the default branch! Always try explicit branch
// refs (`@main`, `@master`) before falling back to `''`.
const JSDELIVR_CDN_BASE = 'https://cdn.jsdelivr.net/gh';
export const JSDELIVR_REF_CANDIDATES = ['@main', '@master', ''];

// raw.githubusercontent.com 直连可达性探测：3s 超时、失败重试 1 次、结果缓存 5 分钟。
// 探测结果决定 raw 路径走直连还是走代理/jsDelivr（避免国内无代理环境每次抓取都挂满超时）。
// 也支持通过 GITHUB_README_CDN_FIRST=true 直接强制优先走 jsDelivr CDN（完全跳过直连探测）。
const RAW_PROBE_TIMEOUT_MS = 3000;
const RAW_PROBE_MAX_RETRIES = 1;
const RAW_PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
const RAW_PROBE_TARGET = `${RAW_GITHUB_BASE}/`;

let rawProbeCache: { reachable: boolean; checkedAt: number } | null = null;
let rawProbePromise: Promise<boolean> | null = null;

export function __resetGithubReadmeCacheForTests(): void {
    rawProbeCache = null;
    rawProbePromise = null;
}

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
    // 'invalid' 是**内容级**失败（HTTP 200 但内容为空/无效）：不能当作"域名不可达"，
    // 否则同一 host 下的后续候选文件名（README.markdown 等）会被整轮跳过
    | { status: 'invalid'; message: string }
    | { status: 'error'; message: string };

/** 构造 README 抓取请求选项；forceDirect=true 时直连（raw 直连额外用可信 host 语义） */
function buildReadmeOptions(label: string, forceDirect: boolean, timeout: number) {
    return {
        ...buildAxiosRequestOptions({
            headers: {
                'User-Agent': 'GitHub-README-Fetcher/1.0',
                // 可选 GITHUB_TOKEN：提高 raw 的速率上限（匿名额度用尽时会 403，README 抓取整体失败）
                ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
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
        // P1-2：若探测认为直连可达但实际路径抓取超时/网络失败，立即置直连缓存为 false 并尝试走代理重试一次，
        // 避免直接放弃 raw 掉进 jsDelivr 旧 tag！
        // 直连不可达且配置了代理 → raw 走代理（代理通常可通 GitHub）；
        // 直连不可达且无代理 → 返回错误，由主循环转 jsDelivr CDN 兜底。
        let response: AxiosResponse;
        if (label === 'raw') {
            const hasProxyAvailable = async () => Boolean((config.useProxy && config.proxyUrl) || (await detectSystemProxy()));
            if (await isRawDirectlyReachable()) {
                try {
                    response = await requestWithSafeRedirects('GET', url, buildReadmeOptions('raw', true, timeout), 'raw.githubusercontent.com');
                } catch (directError) {
                    const directMsg = directError instanceof Error ? directError.message : String(directError);
                    if (isNetworkLayerError(directMsg)) {
                        rawProbeCache = { reachable: false, checkedAt: Date.now() };
                        if (await hasProxyAvailable()) {
                            console.warn(`Direct raw.githubusercontent.com fetch failed (${directMsg}), retrying via proxy: ${url}`);
                            response = await requestWithSafeRedirects('GET', url, buildReadmeOptions('raw', false, timeout), 'raw.githubusercontent.com (proxy)');
                        } else {
                            throw directError;
                        }
                    } else {
                        throw directError;
                    }
                }
            } else if (await hasProxyAvailable()) {
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

        return { status: 'invalid', message: 'Empty or invalid README content' };
    } catch (error: unknown) {
        const errObj = error as { code?: string; response?: { status?: number } };
        const isTimeout = errObj?.code === 'ECONNABORTED';
        const status = typeof errObj?.response?.status === 'number' ? errObj.response.status : undefined;
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
                if (owner && rawRepo) {
                    // Clean repo name: remove query params, fragments, .git suffix, paths
                    const repo = rawRepo.replace(/(?:[?#].*$|\.git$|\/.*$)/g, '');
                    if (owner.length > 0 && repo.length > 0) {
                        return { owner: owner.trim(), repo: repo.trim(), host };
                    }
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
    } catch (error: unknown) {
        const errObj = error as { response?: { status?: number } };
        const status = typeof errObj?.response?.status === 'number' ? errObj.response.status : undefined;
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
    const cdnFirst = process.env.GITHUB_README_CDN_FIRST === 'true';
    let rawUnreachable = false;
    let sawRawError = false;
    let sawCdnError = false;
    let sawAuthoritativeNotFound = false;

    for (let i = 0; i < README_CANDIDATES.length; i += 1) {
        const readmeFile = README_CANDIDATES[i]!;

        // 1) Try raw.githubusercontent.com first, unless CDN-first is forced or
        //    a previous candidate proved the raw host unreachable.
        if (!cdnFirst && !rawUnreachable) {
            const rawUrl = `${RAW_GITHUB_BASE}/${ownerEnc}/${repoEnc}/HEAD/${readmeFile}`;
            const rawResult = await fetchReadmeSource(rawUrl, 'raw', 10000);

            if (rawResult.status === 'ok') {
                return rawResult.content;
            }
            if (rawResult.status === 'notfound') {
                sawAuthoritativeNotFound = true;
                // P1-1：raw 的 HEAD 已经指向仓库默认分支；既然 raw 可达且明确返回 404，
                // 无需再对同一个文件名去 jsDelivr 重复请求多个分支 ref，直接看下一个候选文件名。
                continue;
            }
            if (rawResult.status === 'error') {
                sawRawError = true;
                // Domain-level failure: later candidates should not retry the raw host.
                rawUnreachable = true;
            }
        }

        // 2) Fall back to the jsDelivr CDN mirror ONLY when CDN-first is enabled or raw was unreachable/invalid.
        //    P1-1：仅对首选 README.md 轮询完整分支列表（@main / @master / 默认），
        //    其余备选文件名（readme.md / README.rst 等）仅用默认 ref（''）探测 1 次，避免 10×5=50 次请求风暴。
        const refsToTry = i === 0 ? JSDELIVR_REF_CANDIDATES : [''];
        for (const ref of refsToTry) {
            const cdnUrl = `${JSDELIVR_CDN_BASE}/${ownerEnc}/${repoEnc}${ref}/${readmeFile}`;
            const cdnResult = await fetchReadmeSource(cdnUrl, 'jsDelivr', 10000);

            if (cdnResult.status === 'ok') {
                return cdnResult.content;
            }
            if (cdnResult.status === 'notfound') {
                sawAuthoritativeNotFound = true;
            } else if (cdnResult.status === 'error') {
                sawCdnError = true;
            }
        }
    }

    if ((sawRawError || sawCdnError) && !sawAuthoritativeNotFound) {
        // 所有候选源都出现非 404 错误（网络不可达/上游错误）：抛明确错误，
        // 避免调用方把"网络不通"误报为"README not found"
        throw new AppError({
            code: 'network_error',
            retryable: true,
            engine: 'github',
            hint: 'Check network/proxy configuration.',
            message: `Failed to fetch README for ${owner}/${repo}: all sources (raw.githubusercontent.com, proxy, jsDelivr CDN) failed — network unreachable or upstream error. Check network/proxy configuration.`
        });
    }
    console.warn(`README not found for ${owner}/${repo}`);

    return null;
}

/**
 * 从 GitHub 仓库抓取指定源码文件（支持 blob 链接）。
 * 优先 raw.githubusercontent.com，不可达时通过 jsDelivr CDN 兜底。
 */
async function fetchGithubBlob(
    owner: string,
    repo: string,
    branch: string,
    filePath: string
): Promise<string | null> {
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const cleanPath = filePath.split('/').map(encodeURIComponent).join('/');
    const branchEnc = encodeURIComponent(branch.trim());

    const rawUrl = `${RAW_GITHUB_BASE}/${ownerEnc}/${repoEnc}/${branchEnc}/${cleanPath}`;
    const rawResult = await fetchReadmeSource(rawUrl, 'raw', 15000);
    if (rawResult.status === 'ok') {
        return rawResult.content;
    }

    // jsDelivr 兜底
    const cdnUrl = `${JSDELIVR_CDN_BASE}/${ownerEnc}/${repoEnc}@${branchEnc}/${cleanPath}`;
    const cdnResult = await fetchReadmeSource(cdnUrl, 'jsDelivr', 15000);
    if (cdnResult.status === 'ok') {
        return cdnResult.content;
    }

    return null;
}

/**
 * 通过 GitHub REST API 获取 Issue 详情与评论讨论（免 key 10次/分，支持 GITHUB_TOKEN）。
 */
async function fetchGithubIssue(
    owner: string,
    repo: string,
    issueNumber: string
): Promise<string | null> {
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const numEnc = encodeURIComponent(issueNumber.trim());

    try {
        const headers = {
            'User-Agent': 'GitHub-Issue-Fetcher/1.0',
            'Accept': 'application/vnd.github.v3+json',
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
        };

        const issueUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/issues/${numEnc}`;
        const issueRes = await requestDirectFirst('GET', issueUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                headers,
                timeout: 10000,
                forceDirect
            })
        }), 'GitHub Issue API');

        if (issueRes.status === 404) {
            return null;
        }

        const issueData = issueRes.data as {
            number: number;
            title: string;
            state: string;
            user?: { login: string };
            created_at: string;
            body?: string;
            html_url: string;
            comments?: number;
        };

        const lines: string[] = [
            `# Issue #${issueData.number}: ${issueData.title}`,
            `- **Status**: ${issueData.state.toUpperCase()}`,
            `- **Author**: @${issueData.user?.login ?? 'unknown'}`,
            `- **Created**: ${issueData.created_at}`,
            `- **URL**: ${issueData.html_url}`,
            '',
            '## Description',
            issueData.body?.trim() || '_No description provided._'
        ];

        // 尝试抓取前 15 条评论
        if (issueData.comments && issueData.comments > 0) {
            try {
                const commentsUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/issues/${numEnc}/comments?per_page=15`;
                const commentsRes = await requestDirectFirst('GET', commentsUrl, (forceDirect) => ({
                    ...buildAxiosRequestOptions({
                        headers,
                        timeout: 10000,
                        forceDirect
                    })
                }), 'GitHub Issue Comments API');

                const comments = commentsRes.data as Array<{
                    user?: { login: string };
                    created_at: string;
                    body?: string;
                }>;

                if (Array.isArray(comments) && comments.length > 0) {
                    lines.push('', `## Discussion (${comments.length} comments)`);
                    for (let idx = 0; idx < comments.length; idx += 1) {
                        const c = comments[idx];
                        if (c) {
                            lines.push(
                                '',
                                `### Comment ${idx + 1} by @${c.user?.login ?? 'unknown'} (${c.created_at})`,
                                c.body?.trim() || '_Empty comment_'
                            );
                        }
                    }
                }
            } catch (commentErr) {
                console.warn(`Failed to fetch comments for issue #${issueNumber}:`, commentErr instanceof Error ? commentErr.message : String(commentErr));
            }
        }

        return lines.join('\n');
    } catch (error) {
        console.error(`Failed to fetch issue #${issueNumber} for ${owner}/${repo}:`, error instanceof Error ? error.message : String(error));
        return null;
    }
}

/**
 * Main function: parse URL and fetch README / source file / issue content
 * @param githubUrl GitHub repository URL
 * @returns Content string or null if failed
 */
async function getReadmeFromUrl(githubUrl: string): Promise<string | null> {
    console.error(`\n--- Processing URL: ${githubUrl} ---`);

    if (!githubUrl?.trim()) {
        console.error('Invalid URL provided');
        return null;
    }

    const trimmed = githubUrl.trim();

    // 1. 匹配 GitHub blob 源码文件链接：https://github.com/{owner}/{repo}/blob/{branch}/{path}
    const blobMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/blob\/([^\/\s]+)\/(.+)/i);
    if (blobMatch && blobMatch[1] && blobMatch[2] && blobMatch[3] && blobMatch[4]) {
        const owner = blobMatch[1];
        const repo = blobMatch[2];
        const branch = blobMatch[3];
        const filePath = blobMatch[4];
        console.error(`✅ Detected GitHub source file: ${owner}/${repo} @ ${branch}:${filePath}`);
        return fetchGithubBlob(owner, repo, branch, filePath.replace(/[?#].*$/, ''));
    }

    // 2. 匹配 GitHub Issue 链接：https://github.com/{owner}/{repo}/issues/{number}
    const issueMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/issues\/(\d+)/i);
    if (issueMatch && issueMatch[1] && issueMatch[2] && issueMatch[3]) {
        const owner = issueMatch[1];
        const repo = issueMatch[2];
        const issueNumber = issueMatch[3];
        console.error(`✅ Detected GitHub issue: ${owner}/${repo} #${issueNumber}`);
        return fetchGithubIssue(owner, repo, issueNumber);
    }

    // 3. 默认 README 抓取流程
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
 * Fetch README content, code file, or issue discussion from GitHub repository
 * @param githubUrl GitHub URL (supports repo, /blob/... files, /issues/...)
 * @returns Content string or null if failed
 */
export async function fetchGithubReadme(githubUrl: string): Promise<string | null> {
    return getReadmeFromUrl(githubUrl);
}
