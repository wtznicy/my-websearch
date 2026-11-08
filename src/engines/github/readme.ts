import axios, { type AxiosResponse } from 'axios';
import { Buffer } from 'node:buffer';
import { config } from '../../config.js';
import { buildAxiosRequestOptions, isNetworkLayerError, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { detectSystemProxy } from '../../utils/systemProxy.js';
import { AppError } from '../../core/errors.js';
import { getOptionalString } from '../../config/env.js';
import { RepoHost } from './parseHelpers.js';
import {
    attemptTimeoutMs,
    buildJsdelivrPath,
    ContentBudgetExhaustedError,
    createContentBudget,
    isBudgetExhausted,
    isGithubContentCdnFirst,
    JSDELIVR_HOSTS,
    remainingMs,
    type ContentBudget
} from './contentBudget.js';

export const README_CANDIDATES = [
    'README.md',
    'readme.md',
    'README.rst',
    'README.mdx',
    'README.markdown',
    'README',
    'README.txt'
];

export const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com';
export const JSDELIVR_REF_CANDIDATES = ['@main', '@master', ''];

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

export async function isRawDirectlyReachable(): Promise<boolean> {
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

export type ReadmeFetchOutcome =
    | { status: 'ok'; content: string }
    | { status: 'notfound' }
    | { status: 'invalid'; message: string }
    | { status: 'error'; message: string; httpStatus?: number };

export function buildReadmeOptions(label: string, forceDirect: boolean, timeout: number, signal?: AbortSignal) {
    return {
        ...buildAxiosRequestOptions({
            headers: {
                'User-Agent': 'GitHub-README-Fetcher/1.0',
                ...(getOptionalString('GITHUB_TOKEN') ? { Authorization: `Bearer ${getOptionalString('GITHUB_TOKEN')}` } : {})
            },
            trustedStaticHost: forceDirect && (label === 'raw' || label === 'jsDelivr'),
            forceDirect,
            timeout,
            ...(signal ? { signal } : {}),
            responseType: 'text',
            validateStatus: (status) => status === 200 || status === 404
        })
    };
}

export async function fetchJsDelivr(pathAfterGh: string, budget: ContentBudget, signal?: AbortSignal): Promise<AxiosResponse> {
    let lastError: unknown;
    for (const host of JSDELIVR_HOSTS) {
        if (budget.deadHosts.has(host)) {
            continue;
        }

        const timeout = attemptTimeoutMs(budget, 5000);
        const normalizedPath = pathAfterGh.startsWith('/') ? pathAfterGh : `/${pathAfterGh}`;
        const url = `https://${host}/gh${normalizedPath}`;
        try {
            return await requestWithSafeRedirects(
                'GET',
                url,
                buildReadmeOptions('jsDelivr', true, timeout, signal),
                'jsDelivr CDN'
            );
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            if (isNetworkLayerError(message)) {
                budget.deadHosts.add(host);
                console.warn(`jsDelivr host ${host} hit network error, disabling for this request: ${message}`);
            } else {
                throw error;
            }
        }
    }

    throw lastError ?? new ContentBudgetExhaustedError();
}

export type ReadmeSource =
    | { kind: 'raw'; url: string }
    | { kind: 'jsdelivr'; path: string };

export async function fetchReadmeSource(source: ReadmeSource, budget: ContentBudget): Promise<ReadmeFetchOutcome> {
    const isRaw = source.kind === 'raw';
    const label = isRaw ? 'raw.githubusercontent.com' : 'jsDelivr CDN';
    const displayUrl = isRaw
        ? source.url
        : `https://cdn.jsdelivr.net/gh${source.path.startsWith('/') ? source.path : `/${source.path}`}`;

    const timeout = attemptTimeoutMs(budget, isRaw ? 8000 : 5000);
    const budgetController = new AbortController();
    const budgetTimer = setTimeout(() => {
        budgetController.abort();
    }, remainingMs(budget));

    try {
        let response: AxiosResponse;
        if (source.kind === 'raw') {
            const hasProxyAvailable = async () => Boolean((config.useProxy && config.proxyUrl) || (await detectSystemProxy()));
            const canAffordProbe = remainingMs(budget) > RAW_PROBE_TIMEOUT_MS;
            if (!canAffordProbe || await isRawDirectlyReachable()) {
                try {
                    response = await requestWithSafeRedirects('GET', source.url, buildReadmeOptions('raw', true, timeout, budgetController.signal), 'raw.githubusercontent.com');
                } catch (directError) {
                    const directMsg = directError instanceof Error ? directError.message : String(directError);
                    if (isNetworkLayerError(directMsg)) {
                        rawProbeCache = { reachable: false, checkedAt: Date.now() };
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

export async function fetchGiteeReadme(owner: string, repo: string): Promise<ReadmeFetchOutcome> {
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const apiUrl = `https://gitee.com/api/v5/repos/${ownerEnc}/${repoEnc}/readme`;

    try {
        const response = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'Gitee-README-Fetcher/1.0',
                'Accept': 'application/json'
            },
            timeout: 8000,
            validateStatus: (status) => status === 200 || status === 404
        });

        if (response.status === 404) {
            return { status: 'notfound' };
        }

        const data = response.data as { content?: string; encoding?: string };
        const content = data?.content;
        const encoding = data?.encoding ?? 'base64';

        if (typeof content === 'string' && content.trim() && encoding === 'base64') {
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

export async function fetchReadme(owner: string, repo: string, host: RepoHost): Promise<string | null> {
    if (!owner?.trim() || !repo?.trim()) {
        console.error('Invalid owner or repo name provided');
        return null;
    }

    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());

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

        if (!cdnFirst) {
            const hit = await tryRaw(readmeFile);
            if (hit !== null) {
                return hit;
            }
            if (sawAuthoritativeNotFound && rawTried && !rawUnreachable) {
                continue;
            }
        }

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
                if (budget.deadHosts.size >= JSDELIVR_HOSTS.length) {
                    break;
                }
            }
        }
        if (budgetExhausted) {
            break;
        }
    }

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
        throw new AppError({
            code: 'network_error',
            retryable: true,
            engine: 'github',
            hint: 'Check network/proxy configuration.',
            message: `Failed to fetch README for ${owner}/${repo}: all sources (raw.githubusercontent.com, proxy, jsDelivr CDN) failed – network unreachable or upstream error. Check network/proxy configuration.`
        });
    }
    console.warn(`README not found for ${owner}/${repo}`);

    return null;
}
