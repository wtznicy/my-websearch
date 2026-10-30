import axios from 'axios';
import type { AxiosResponse } from 'axios';
import { Buffer } from 'node:buffer';
import { config } from '../../config.js';
import { buildAxiosRequestOptions, isNetworkLayerError, requestDirectFirst, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { detectSystemProxy } from '../../utils/systemProxy.js';
import { AppError } from '../../core/errors.js';
import { detectLanguageFromPath, formatSourceFile, renderAsciiTree } from './format.js';
import { LineRange, parseLineRangeFromUrl } from './lineRange.js';
import { fetchGiteeBlob, fetchGiteeCommit, fetchGiteeCompare, fetchGiteeIssue, fetchGiteePullRequest, fetchGiteeReleases, fetchGiteeTree } from './gitee.js';
import { fetchGithubCommit, fetchGithubCompare, fetchGithubReleases } from './changes.js';
import { fetchGithubIssue, fetchGithubPullRequest } from './discussion.js';
import {
    attemptTimeoutMs,
    buildJsdelivrPath,
    ContentBudgetExhaustedError,
    createContentBudget,
    formatChangedFilesSection,
    isBudgetExhausted,
    isGithubContentCdnFirst,
    JSDELIVR_HOSTS,
    remainingMs,
    type ContentBudget
} from './contentBudget.js';

export { detectLanguageFromPath, formatSourceFile, renderAsciiTree };

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
    | { status: 'error'; message: string; httpStatus?: number };

/** 构造 README 抓取请求选项；forceDirect=true 时直连（raw / jsDelivr 都是固定可信 CDN host） */
function buildReadmeOptions(label: string, forceDirect: boolean, timeout: number, signal?: AbortSignal) {
    return {
        ...buildAxiosRequestOptions({
            headers: {
                'User-Agent': 'GitHub-README-Fetcher/1.0',
                // 可选 GITHUB_TOKEN：提高 raw 的速率上限（匿名额度用尽时会 403，README 抓取整体失败）
                ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
            },
            // raw 与 jsDelivr 的域名都由代码硬编码，属于「固定可信 host」。
            // 走 trustedStaticHost 还能避开 request-filtering-agent 的 fake-IP 白名单在
            // IPv6 目标上的 `Invalid CIDR 198.18.0.0/15` 崩溃（该库拿 v4 CIDR 去匹配 v6 地址）。
            trustedStaticHost: forceDirect && (label === 'raw' || label === 'jsDelivr'),
            forceDirect,
            timeout,
            ...(signal ? { signal } : {}),
            responseType: 'text',
            validateStatus: (status) => status === 200 || status === 404
        })
    };
}

/**
 * jsDelivr CDN 抓取：host 轮转，只在网络层失败时换下一个域名。
 * 404/5xx 属于内容问题，换域名结果一样，直接交回上层分类。
 */
async function fetchJsDelivr(pathAfterGh: string, budget: ContentBudget, signal?: AbortSignal): Promise<AxiosResponse> {
    const hosts = budget.preferredHost
        ? [budget.preferredHost, ...JSDELIVR_HOSTS.filter((host) => host !== budget.preferredHost)]
        : [...JSDELIVR_HOSTS];
    let lastError: unknown;

    for (const host of hosts) {
        if (budget.deadHosts.has(host) || isBudgetExhausted(budget)) {
            continue;
        }
        try {
            const response = await requestDirectFirst(
                'GET',
                `https://${host}/gh${pathAfterGh}`,
                (forceDirect) => buildReadmeOptions('jsDelivr', forceDirect, attemptTimeoutMs(budget), signal),
                `jsDelivr CDN (${host})`
            );
            budget.preferredHost = host;
            return response;
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            if (!isNetworkLayerError(message)) {
                throw error;
            }
            budget.deadHosts.add(host);
            console.warn(`jsDelivr host ${host} failed (${message}); trying next host`);
        }
    }

    throw lastError ?? new ContentBudgetExhaustedError();
}

type ReadmeSource =
    | { kind: 'raw'; url: string }
    | { kind: 'jsdelivr'; path: string };

/**
 * Fetch one README candidate and classify the outcome.
 * 所有请求共享同一个 ContentBudget：单次 timeout 取 min(4.5s, 剩余预算)。
 */
async function fetchReadmeSource(source: ReadmeSource, budget: ContentBudget): Promise<ReadmeFetchOutcome> {
    const label = source.kind === 'raw' ? 'raw' : 'jsDelivr';
    const displayUrl = source.kind === 'raw'
        ? source.url
        : `https://${budget.preferredHost ?? JSDELIVR_HOSTS[0]}/gh${source.path}`;
    const timeout = attemptTimeoutMs(budget);
    // 硬预算：即使 requestDirectFirst 内部先直连再代理（两次请求），也不能突破总预算
    const budgetController = new AbortController();
    const budgetTimer = setTimeout(() => budgetController.abort(new ContentBudgetExhaustedError()), Math.max(1, remainingMs(budget)));
    budgetTimer.unref?.();

    try {
        console.error(`Fetching README from ${label}: ${displayUrl}`);

        // raw：先探测直连可达性——
        // 直连可达 → 直连（可信 host，绕过 DNS 私网过滤，避免 100.64.0.0/10 误判为 SSRF）；
        // P1-2：若探测认为直连可达但实际路径抓取超时/网络失败，立即置直连缓存为 false 并尝试走代理重试一次，
        // 避免直接放弃 raw 掉进 jsDelivr 旧 tag！
        // 直连不可达且配置了代理 → raw 走代理（代理通常可通 GitHub）；
        // 直连不可达且无代理 → 返回错误，由主循环转 jsDelivr CDN 兜底。
        let response: AxiosResponse;
        if (source.kind === 'raw') {
            const hasProxyAvailable = async () => Boolean((config.useProxy && config.proxyUrl) || (await detectSystemProxy()));
            // 探测本身也要花 3s：预算不够时跳过探测，直接尝试直连（失败再走代理），
            // 否则 CDN-first 的「快速失败」会被探测时间吃掉。
            const canAffordProbe = remainingMs(budget) > RAW_PROBE_TIMEOUT_MS;
            if (!canAffordProbe || await isRawDirectlyReachable()) {
                try {
                    response = await requestWithSafeRedirects('GET', source.url, buildReadmeOptions('raw', true, timeout, budgetController.signal), 'raw.githubusercontent.com');
                } catch (directError) {
                    const directMsg = directError instanceof Error ? directError.message : String(directError);
                    if (isNetworkLayerError(directMsg)) {
                        rawProbeCache = { reachable: false, checkedAt: Date.now() };
                        // 系统代理探测本身可能要 1-3s；预算不够时不要为「可能存在的代理」再烧一轮
                        if (remainingMs(budget) > 1000 && await hasProxyAvailable()) {
                            console.warn(`Direct raw.githubusercontent.com fetch failed (${directMsg}), retrying via proxy: ${source.url}`);
                            response = await requestWithSafeRedirects('GET', source.url, buildReadmeOptions('raw', false, timeout, budgetController.signal), 'raw.githubusercontent.com (proxy)');
                        } else {
                            throw directError;
                        }
                    } else {
                        throw directError;
                    }
                }
            } else if (remainingMs(budget) > 1000 && await hasProxyAvailable()) {
                response = await requestWithSafeRedirects('GET', source.url, buildReadmeOptions('raw', false, timeout, budgetController.signal), 'raw.githubusercontent.com (proxy)');
            } else {
                return { status: 'error', message: 'raw.githubusercontent.com is unreachable from the current network without a proxy' };
            }
        } else {
            response = await fetchJsDelivr(source.path, budget, budgetController.signal);
        }

        if (response.status === 404) {
            return { status: 'notfound' };
        }

        // jsDelivr 对个别文件会 301 回 raw（body 是 "Moved Permanently. Redirecting to ..." 文本）。
        // 这种 body 不是文件内容，必须当错误处理，否则会把重定向说明当成源码返回。
        if (response.status !== 200) {
            return { status: 'error', message: `Upstream returned HTTP ${response.status} instead of file content`, httpStatus: response.status };
        }

        if (typeof response.data === 'string' && response.data.trim()) {
            if (/^Moved Permanently\.\s+Redirecting to /i.test(response.data.trim())) {
                return { status: 'error', message: 'Upstream returned a redirect stub instead of file content' };
            }
            return { status: 'ok', content: response.data };
        }

        return { status: 'invalid', message: 'Empty or invalid README content' };
    } catch (error: unknown) {
        const errObj = error as { code?: string; response?: { status?: number } };
        const isTimeout = errObj?.code === 'ECONNABORTED';
        const status = typeof errObj?.response?.status === 'number' ? errObj.response.status : undefined;
        const message = error instanceof Error ? error.message : String(error);

        if (isTimeout) {
            console.error(`Timeout fetching README from ${label}: ${displayUrl}`);
        } else if (status !== undefined) {
            console.error(`Failed to fetch README from ${label}: ${displayUrl} (HTTP ${status}):`, message);
        } else {
            console.error(`Network error fetching README from ${label}: ${displayUrl}:`, message);
        }

        return { status: 'error', message, ...(status !== undefined ? { httpStatus: status } : {}) };
    } finally {
        clearTimeout(budgetTimer);
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

    // github：raw.githubusercontent.com + jsDelivr CDN 双路径（共享总预算）
    const cdnFirst = isGithubContentCdnFirst();
    const budget = createContentBudget();
    console.error(`GitHub content budget: ${Math.max(0, remainingMs(budget))}ms, cdnFirst=${cdnFirst}`);
    let rawUnreachable = false;
    let rawTried = false;
    let sawRawError = false;
    let sawCdnError = false;
    let sawAuthoritativeNotFound = false;
    let budgetExhausted = false;

    const tryRaw = async (readmeFile: string): Promise<string | null> => {
        if (rawUnreachable || isBudgetExhausted(budget)) {
            return null;
        }
        rawTried = true;
        const rawResult = await fetchReadmeSource(
            { kind: 'raw', url: `${RAW_GITHUB_BASE}/${ownerEnc}/${repoEnc}/HEAD/${readmeFile}` },
            budget
        );
        if (rawResult.status === 'ok') {
            return rawResult.content;
        }
        if (rawResult.status === 'notfound') {
            sawAuthoritativeNotFound = true;
        } else if (rawResult.status === 'error') {
            sawRawError = true;
            rawUnreachable = true;
        }
        return null;
    };

    for (let i = 0; i < README_CANDIDATES.length; i += 1) {
        if (isBudgetExhausted(budget)) {
            budgetExhausted = true;
            break;
        }
        const readmeFile = README_CANDIDATES[i]!;

        // 1) raw first, unless CDN-first is forced or the raw host already failed.
        if (!cdnFirst) {
            const hit = await tryRaw(readmeFile);
            if (hit !== null) {
                return hit;
            }
            if (sawAuthoritativeNotFound && rawTried && !rawUnreachable) {
                // raw 的 HEAD 已指向默认分支且明确 404：直接看下一个候选文件名
                continue;
            }
        }

        // 2) jsDelivr 兜底（或 CDN-first 主路径）
        //    仅对首选 README.md 轮询 @main/@master/默认，其余文件名只试默认 ref。
        const refsToTry = i === 0 ? JSDELIVR_REF_CANDIDATES : [''];
        for (const ref of refsToTry) {
            if (isBudgetExhausted(budget)) {
                budgetExhausted = true;
                break;
            }
            const cdnResult = await fetchReadmeSource(
                { kind: 'jsdelivr', path: buildJsdelivrPath(ownerEnc, repoEnc, ref, readmeFile) },
                budget
            );
            if (cdnResult.status === 'ok') {
                return cdnResult.content;
            }
            if (cdnResult.status === 'notfound') {
                sawAuthoritativeNotFound = true;
            } else if (cdnResult.status === 'error') {
                sawCdnError = true;
                // 所有 host 都因网络失败被熔断时，本轮 network 分支会抛 budget/network 错误
                if (budget.deadHosts.size >= JSDELIVR_HOSTS.length) {
                    break;
                }
            }
        }
        if (budgetExhausted) {
            break;
        }
    }

    // CDN-first 但 CDN 全挂：若预算还有剩余，回退 raw 一次（而不是直接失败）
    if (cdnFirst && sawCdnError && !rawTried && !isBudgetExhausted(budget)) {
        const hit = await tryRaw(README_CANDIDATES[0]!);
        if (hit !== null) {
            return hit;
        }
    }

    if (budgetExhausted) {
        throw new AppError({
            code: 'network_timeout',
            retryable: true,
            engine: 'github',
            hint: 'Increase GITHUB_CONTENT_BUDGET_MS, enable a proxy, or retry later.',
            message: `Failed to fetch README for ${owner}/${repo}: content budget exhausted before any source returned content.`
        });
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

type BlobFetchOutcome =
    | { status: 'ok'; content: string }
    | { status: 'notfound' }
    | { status: 'error'; message: string };

/**
 * 从 GitHub 仓库抓取指定源码文件（支持 blob 链接）。
 * 优先 raw.githubusercontent.com，不可达时通过 jsDelivr CDN 兜底。
 * 区分 404 与网络错误：404 时上层可返回“该目录下有哪些文件”的教学式提示，
 * 避免模型在路径/ref 写错时只拿到一句无法行动的 "Content not found"。
 */
async function fetchGithubBlob(
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
    lineRange?: LineRange
): Promise<BlobFetchOutcome> {
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const cleanPath = filePath.split('/').map(encodeURIComponent).join('/');
    const branchEnc = encodeURIComponent(branch.trim());

    // blob 与 README 共用同一套开关与预算：CDN-first 时不再先白等 raw。
    const cdnFirst = isGithubContentCdnFirst();
    const budget = createContentBudget();
    const cdnPath = buildJsdelivrPath(ownerEnc, repoEnc, `@${branchEnc}`, cleanPath);

    const tryCdn = async (): Promise<ReadmeFetchOutcome> => fetchReadmeSource({ kind: 'jsdelivr', path: cdnPath }, budget);
    const tryRaw = async (): Promise<ReadmeFetchOutcome> => fetchReadmeSource(
        { kind: 'raw', url: `${RAW_GITHUB_BASE}/${ownerEnc}/${repoEnc}/${branchEnc}/${cleanPath}` },
        budget
    );

    let rawResult: ReadmeFetchOutcome = { status: 'error', message: 'raw source skipped (CDN-first)' };
    let cdnResult: ReadmeFetchOutcome = { status: 'error', message: 'CDN source skipped' };

    if (cdnFirst) {
        cdnResult = await tryCdn();
        if (cdnResult.status === 'ok') {
            return { status: 'ok', content: formatSourceFile(owner, repo, branch, filePath, cdnResult.content, lineRange) };
        }
        // CDN 失败且预算还有剩余：补一次 raw（而不是直接失败）
        if (!isBudgetExhausted(budget)) {
            rawResult = await tryRaw();
        }
    } else {
        rawResult = await tryRaw();
        if (rawResult.status === 'ok') {
            return { status: 'ok', content: formatSourceFile(owner, repo, branch, filePath, rawResult.content, lineRange) };
        }
        if (!isBudgetExhausted(budget)) {
            cdnResult = await tryCdn();
        }
    }

    if (rawResult.status === 'ok') {
        return { status: 'ok', content: formatSourceFile(owner, repo, branch, filePath, rawResult.content, lineRange) };
    }
    if (cdnResult.status === 'ok') {
        return { status: 'ok', content: formatSourceFile(owner, repo, branch, filePath, cdnResult.content, lineRange) };
    }

    const rawNotFound = rawResult.status === 'notfound'
        || (rawResult.status === 'error' && rawResult.httpStatus === 404);
    const cdnNotFound = cdnResult.status === 'notfound'
        || (cdnResult.status === 'error' && cdnResult.httpStatus === 404);
    if (rawNotFound || cdnNotFound) {
        return { status: 'notfound' };
    }

    const message = rawResult.status === 'error'
        ? rawResult.message
        : (cdnResult.status === 'error' ? cdnResult.message : 'empty or invalid response');
    return { status: 'error', message };
}

/**
 * 列出目标文件所在目录下的文件名（best-effort）。
 * 只在 404 教学提示路径调用；GitHub Contents API 匿名额度有限，失败时静默返回空数组。
 */
async function fetchSiblingFileNames(
    owner: string,
    repo: string,
    ref: string,
    filePath: string
): Promise<string[]> {
    const dirPath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const refParam = encodeURIComponent(ref.trim());
    const contentsPath = dirPath
        ? `${dirPath.split('/').map(encodeURIComponent).join('/')}/`
        : '';
    const apiUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/contents/${contentsPath}?ref=${refParam}`;

    try {
        const headers: Record<string, string> = {
            'User-Agent': 'GitHub-Content-Fetcher/1.0',
            'Accept': 'application/vnd.github.v3+json',
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
        };
        const res = await requestDirectFirst('GET', apiUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({ headers, timeout: 8000, forceDirect })
        }), 'GitHub contents API');
        if (res.status !== 200 || !Array.isArray(res.data)) {
            return [];
        }
        return (res.data as Array<{ name?: unknown; type?: unknown }>)
            .filter((item) => item?.type === 'file' && typeof item.name === 'string')
            .map((item) => item.name as string)
            .slice(0, 12);
    } catch {
        return [];
    }
}

/**
 * 构造“文件不存在”的教学式错误：给出同目录候选文件，模型可直接改 URL 重试，
 * 不必再猜路径或额外调用一次 tree。
 */
async function createMissingBlobError(
    owner: string,
    repo: string,
    ref: string,
    filePath: string
): Promise<AppError> {
    const dirPath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const dirSuffix = dirPath ? `/${dirPath}` : '';
    const treeUrl = `https://github.com/${owner}/${repo}/tree/${ref}${dirSuffix}`;
    const siblings = await fetchSiblingFileNames(owner, repo, ref, filePath);

    const requestedBase = filePath.split('/').pop() ?? filePath;
    const pickClosestSibling = (names: string[]): string => {
        const requested = requestedBase.toLowerCase();
        let best = names[0]!;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const name of names) {
            const lower = name.toLowerCase();
            let prefix = 0;
            while (prefix < lower.length && prefix < requested.length && lower[prefix] === requested[prefix]) {
                prefix += 1;
            }
            const score = prefix * 10 - Math.abs(lower.length - requested.length);
            if (score > bestScore) {
                bestScore = score;
                best = name;
            }
        }
        return best;
    };

    let hint: string;
    if (siblings.length > 0) {
        const shown = siblings.slice(0, 8);
        const exampleUrl = `https://github.com/${owner}/${repo}/blob/${ref}${dirSuffix}/${pickClosestSibling(siblings)}`;
        hint = `文件不存在：${owner}/${repo}@${ref}${dirSuffix}/${filePath.split('/').pop() ?? filePath}。该目录下可读文件：${shown.join(', ')}${siblings.length > shown.length ? ` 等 ${siblings.length} 个` : ''}。示例 URL：${exampleUrl}；或先看目录：${treeUrl}。`;
    } else {
        hint = `文件不存在：${owner}/${repo}@${ref}${dirSuffix}/${filePath.split('/').pop() ?? filePath}。请确认 ref（分支/tag/commit）与路径；可先读取目录：${treeUrl}。`;
    }

    return new AppError({
        code: 'not_found',
        retryable: false,
        status: 404,
        engine: 'github',
        message: `GitHub file not found: ${owner}/${repo}@${ref}/${filePath}`,
        hint
    });
}

type TreeFetchOutcome =
    | { status: 'ok'; content: string }
    | { status: 'notfound' }
    | { status: 'error'; message: string };

/**
 * 通过 GitHub Git Trees API 获取仓库目录树结构。
 * API: GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1
 */
async function fetchGithubTree(
    owner: string,
    repo: string,
    ref: string,
    dirPath?: string
): Promise<TreeFetchOutcome> {
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const refEnc = encodeURIComponent(ref.trim());

    try {
        const headers: Record<string, string> = {
            'User-Agent': 'GitHub-Tree-Fetcher/1.0',
            'Accept': 'application/vnd.github.v3+json',
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
        };

        const treeUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/git/trees/${refEnc}?recursive=1`;
        const res = await requestDirectFirst('GET', treeUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                headers,
                timeout: 10000,
                forceDirect
            })
        }), 'GitHub Trees API');

        if (res.status === 404) {
            return { status: 'notfound' };
        }

        const data = res.data as {
            sha?: string;
            tree?: Array<{ path: string; mode: string; type: 'blob' | 'tree'; size?: number }>;
            truncated?: boolean;
        };

        if (!data?.tree || !Array.isArray(data.tree) || data.tree.length === 0) {
            return { status: 'ok', content: `# Directory Tree: ${owner}/${repo} @ ${ref}\n\n_Empty directory or no files found._` };
        }

        let items = data.tree;
        const normalizedDirPath = dirPath ? dirPath.replace(/^\/+|\/+$/g, '') : '';
        if (normalizedDirPath) {
            const prefix = `${normalizedDirPath}/`;
            items = items
                .filter((item) => item.path !== normalizedDirPath && item.path.startsWith(prefix))
                .map((item) => ({
                    ...item,
                    path: item.path.slice(prefix.length),
                    size: item.type === 'blob' ? item.size : undefined
                }))
                .filter((item) => item.path.length > 0);
        }

        // 指定子目录在完整树里找不到，通常意味着路径写错（git 不跟踪空目录）；
        // 返回 notfound 让上层给出 ref/路径提示。超大仓库返回 truncated 时不做此判断。
        if (normalizedDirPath && items.length === 0 && !data.truncated) {
            return { status: 'notfound' };
        }

        const totalItemsCount = items.length;
        const treeNoisePattern = /(^|\/)(node_modules|dist|build|target|coverage|\.next|\.nuxt|out|vendor|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock)(\/|$)/i;
        const filteredNoiseCount = items.filter((item) => treeNoisePattern.test(item.path)).length;
        items = items.filter((item) => !treeNoisePattern.test(item.path));
        const maxTreeItems = 150;
        const isCapped = totalItemsCount > maxTreeItems;
        const displayItems = isCapped ? items.slice(0, maxTreeItems) : items;

        const renderedTree = renderAsciiTree(displayItems);
        const header = `# Directory Tree: ${owner}/${repo} @ ${ref}${normalizedDirPath ? ` (subpath: /${normalizedDirPath})` : ''}\n\nTotal items: ${totalItemsCount}${filteredNoiseCount > 0 ? ` (filtered ${filteredNoiseCount} build/lock artifacts)` : ''}${isCapped ? ` (showing first ${maxTreeItems})` : ''}\n\n`;
        const truncationNotice = isCapped ? `\n\n... and ${totalItemsCount - maxTreeItems} more items.` : '';

        return { status: 'ok', content: `${header}\`\`\`\n${renderedTree}\n\`\`\`${truncationNotice}` };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to fetch tree for ${owner}/${repo} @ ${ref}:`, message);
        return { status: 'error', message };
    }
}


/**
 * 全能 GitHub 内容提取入口：根据 URL 路径智能分流（README、源码、目录树、Issue、PR）
 * @param githubUrl GitHub / Gitee URL
 * @returns 格式化后的 Markdown 内容字符串，失败或 404 返回 null
 */
export async function fetchGithubContent(githubUrl: string, lineRange?: LineRange, releaseLimit = 10): Promise<string | null> {
    console.error(`\n--- Processing URL: ${githubUrl} ---`);

    if (!githubUrl?.trim()) {
        console.error('Invalid URL provided');
        return null;
    }

    const trimmed = githubUrl.trim();
    const effectiveRange = lineRange ?? parseLineRangeFromUrl(trimmed);
    if (effectiveRange && !/\/(?:blob)\//i.test(trimmed)) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            engine: 'github',
            message: 'lines / #L ranges are only supported for /blob/ source-file URLs.',
            hint: 'Open a file URL (/blob/<ref>/<path>) to use line ranges.'
        });
    }

    // 0. Gitee / GitHub 的 commit、compare、releases（结构化 API，不抓 HTML 页面）
    const giteeCommitMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/commit\/([0-9a-f]{7,64})/i);
    if (giteeCommitMatch?.[1] && giteeCommitMatch[2] && giteeCommitMatch[3]) {
        return fetchGiteeCommit(giteeCommitMatch[1], giteeCommitMatch[2], giteeCommitMatch[3]);
    }
    const giteeCompareMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/compare\/([^?#\s]+?)\.\.\.([^?#\s]+)/i);
    if (giteeCompareMatch?.[1] && giteeCompareMatch[2] && giteeCompareMatch[3] && giteeCompareMatch[4]) {
        return fetchGiteeCompare(giteeCompareMatch[1], giteeCompareMatch[2], giteeCompareMatch[3], giteeCompareMatch[4]);
    }
    const giteeReleasesMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/releases(?:\/tag\/([^/?#\s]+))?/i);
    if (giteeReleasesMatch?.[1] && giteeReleasesMatch[2]) {
        return fetchGiteeReleases(giteeReleasesMatch[1], giteeReleasesMatch[2], giteeReleasesMatch[3], releaseLimit);
    }

    // 0. Gitee 与 GitHub 同款资源（blob / tree / issue / pull request）
    const giteeBlobMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/blob\/([^\/\s]+)\/(.+)/i);
    if (giteeBlobMatch && giteeBlobMatch[1] && giteeBlobMatch[2] && giteeBlobMatch[3] && giteeBlobMatch[4]) {
        const owner = giteeBlobMatch[1];
        const repo = giteeBlobMatch[2];
        const ref = giteeBlobMatch[3];
        const filePath = giteeBlobMatch[4].replace(/[?#].*$/, '');
        console.error(`✅ Detected Gitee source file: ${owner}/${repo} @ ${ref}:${filePath}`);
        return fetchGiteeBlob(owner, repo, ref, filePath, effectiveRange);
    }

    const giteeTreeMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/tree\/([^\/\s]+)(?:\/(.+))?/i);
    if (giteeTreeMatch && giteeTreeMatch[1] && giteeTreeMatch[2] && giteeTreeMatch[3]) {
        const owner = giteeTreeMatch[1];
        const repo = giteeTreeMatch[2];
        const ref = giteeTreeMatch[3];
        const dirPath = giteeTreeMatch[4]?.replace(/[?#].*$/, '') || undefined;
        console.error(`✅ Detected Gitee directory tree: ${owner}/${repo} @ ${ref}${dirPath ? ` /${dirPath}` : ''}`);
        return fetchGiteeTree(owner, repo, ref, dirPath);
    }

    const giteeIssueMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/issues\/([^\/?#\s]+)/i);
    if (giteeIssueMatch && giteeIssueMatch[1] && giteeIssueMatch[2] && giteeIssueMatch[3]) {
        const owner = giteeIssueMatch[1];
        const repo = giteeIssueMatch[2];
        const issueNumber = giteeIssueMatch[3];
        console.error(`✅ Detected Gitee issue: ${owner}/${repo} #${issueNumber}`);
        return fetchGiteeIssue(owner, repo, issueNumber);
    }

    const giteePullMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/pulls?\/(\d+)/i);
    if (giteePullMatch && giteePullMatch[1] && giteePullMatch[2] && giteePullMatch[3]) {
        const owner = giteePullMatch[1];
        const repo = giteePullMatch[2];
        const prNumber = giteePullMatch[3];
        console.error(`✅ Detected Gitee pull request: ${owner}/${repo} #${prNumber}`);
        return fetchGiteePullRequest(owner, repo, prNumber);
    }

    // 1. GitHub commit / compare / releases（结构化 API，优先于 HTML 页面）
    const githubCommitMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/commit\/([0-9a-f]{7,64})/i);
    if (githubCommitMatch?.[1] && githubCommitMatch[2] && githubCommitMatch[3]) {
        return fetchGithubCommit(githubCommitMatch[1], githubCommitMatch[2], githubCommitMatch[3]);
    }
    const githubCompareMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/compare\/([^?#\s]+?)\.\.\.([^?#\s]+)/i);
    if (githubCompareMatch?.[1] && githubCompareMatch[2] && githubCompareMatch[3] && githubCompareMatch[4]) {
        return fetchGithubCompare(githubCompareMatch[1], githubCompareMatch[2], githubCompareMatch[3], githubCompareMatch[4]);
    }
    const githubReleasesMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/releases(?:\/(?:tag\/)?([^/?#\s]+))?/i);
    if (githubReleasesMatch?.[1] && githubReleasesMatch[2]) {
        return fetchGithubReleases(githubReleasesMatch[1], githubReleasesMatch[2], githubReleasesMatch[3], releaseLimit);
    }

    // 2. 匹配 GitHub blob 源码文件链接：https://github.com/{owner}/{repo}/blob/{branch}/{path}
    const blobMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/blob\/([^\/\s]+)\/(.+)/i);
    if (blobMatch && blobMatch[1] && blobMatch[2] && blobMatch[3] && blobMatch[4]) {
        const owner = blobMatch[1];
        const repo = blobMatch[2];
        const branch = blobMatch[3];
        const filePath = blobMatch[4].replace(/[?#].*$/, '');
        console.error(`✅ Detected GitHub source file: ${owner}/${repo} @ ${branch}:${filePath}`);
        const blobOutcome = await fetchGithubBlob(owner, repo, branch, filePath, effectiveRange);
        if (blobOutcome.status === 'ok') {
            return blobOutcome.content;
        }
        if (blobOutcome.status === 'notfound') {
            throw await createMissingBlobError(owner, repo, branch, filePath);
        }
        throw new AppError({
            code: 'network_error',
            retryable: true,
            engine: 'github',
            message: `Failed to fetch GitHub file ${owner}/${repo}@${branch}/${filePath}: ${blobOutcome.message}`
        });
    }

    // 2. 匹配 GitHub tree 目录链接：https://github.com/{owner}/{repo}/tree/{branch}(/{path})?
    const treeMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/tree\/([^\/\s]+)(?:\/(.+))?/i);
    if (treeMatch && treeMatch[1] && treeMatch[2] && treeMatch[3]) {
        const owner = treeMatch[1];
        const repo = treeMatch[2];
        const ref = treeMatch[3];
        const dirPath = treeMatch[4]?.replace(/[?#].*$/, '') || undefined;
        console.error(`✅ Detected GitHub directory tree: ${owner}/${repo} @ ${ref}${dirPath ? ` /${dirPath}` : ''}`);
        const treeOutcome = await fetchGithubTree(owner, repo, ref, dirPath);
        if (treeOutcome.status === 'ok') {
            return treeOutcome.content;
        }
        if (treeOutcome.status === 'notfound') {
            throw new AppError({
                code: 'not_found',
                retryable: false,
                status: 404,
                engine: 'github',
                message: `GitHub tree not found: ${owner}/${repo}@${ref}${dirPath ? `/${dirPath}` : ''}`,
                hint: `目录或 ref 不存在：${owner}/${repo}@${ref}${dirPath ? `/${dirPath}` : ''}。请确认 ref 是分支/tag/commit；可先抓 https://github.com/${owner}/${repo}/tree/${ref} 查看实际目录。`
            });
        }
        throw new AppError({
            code: 'network_error',
            retryable: true,
            engine: 'github',
            message: `Failed to fetch GitHub tree ${owner}/${repo}@${ref}: ${treeOutcome.message}`
        });
    }

    // 3. 匹配 GitHub Issue 链接：https://github.com/{owner}/{repo}/issues/{number}
    const issueMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/issues\/(\d+)/i);
    if (issueMatch && issueMatch[1] && issueMatch[2] && issueMatch[3]) {
        const owner = issueMatch[1];
        const repo = issueMatch[2];
        const issueNumber = issueMatch[3];
        console.error(`✅ Detected GitHub issue: ${owner}/${repo} #${issueNumber}`);
        return fetchGithubIssue(owner, repo, issueNumber);
    }

    // 4. 匹配 GitHub Pull Request 链接：https://github.com/{owner}/{repo}/pull/{number}
    const pullMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/pull\/(\d+)/i);
    if (pullMatch && pullMatch[1] && pullMatch[2] && pullMatch[3]) {
        const owner = pullMatch[1];
        const repo = pullMatch[2];
        const prNumber = pullMatch[3];
        console.error(`✅ Detected GitHub pull request: ${owner}/${repo} #${prNumber}`);
        return fetchGithubPullRequest(owner, repo, prNumber);
    }

    // 5. 默认仓库 README 抓取流程
    // 注意：仅当 URL 路径恰好为仓库根目录（/:owner/:repo 或 /:owner/:repo/）时，才抓取 README。
    // 若包含 /releases, /stargazers, /commits 等子路径，返回 null，交由通用网页抓取器提取实际页面正文！
    const isRepoRoot = (urlStr: string): boolean => {
        try {
            if (/^git@(github|gitee)\.com:[^/]+\/[^/]+(?:\.git)?$/i.test(urlStr.trim())) {
                return true;
            }
            const parsed = new URL(urlStr.trim());
            const parts = parsed.pathname.split('/').filter(Boolean);
            return parts.length === 2;
        } catch {
            return false;
        }
    };

    if (!isRepoRoot(trimmed)) {
        console.error(`Not a repository root or supported subresource (e.g. releases/commits/stargazers), skipping GitHub specialized extractor`);
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
 * 向后兼容别名：保留 fetchGithubReadme 导出以供现有代码/单测使用
 */
export const fetchGithubReadme = fetchGithubContent;

