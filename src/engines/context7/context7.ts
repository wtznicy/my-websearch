/**
 * Context7 文档检索客户端。
 *
 * 直接调用 context7 的公开 REST API（https://context7.com/docs/api-guide），
 * 让 my-websearch 具备"官方文档直达 + 来源信誉评分"的能力，无需依赖
 * context7 的 MCP 进程（该进程在本机网络下启动缓慢且易超时）。
 *
 * API 特性：
 * - GET /api/v2/libs/search?libraryName=X&query=Y  查找库
 * - GET /api/v2/context?libraryId=/owner/repo&query=Y&type=json  取文档片段
 * - 认证：Authorization: Bearer CONTEXT7_API_KEY（无 key 时低速率可用）
 * - 库 ID 格式：/owner/repo（GitHub）、/packages/<name>（npm）、/websites/<id> 等
 * - 可钉定版本：/owner/repo@v1.2.3 或 /owner/repo/v1.2.3
 */

import axios from 'axios';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';

export const CONTEXT7_BASE_URL = 'https://context7.com';
export const CONTEXT7_API_VERSION = 'v2';
export type Context7Library = {
    id: string;
    title: string;
    description: string;
    branch?: string;
    lastUpdateDate?: string;
    state?: string;
    totalTokens?: number;
    totalSnippets?: number;
    stars?: number;
    trustScore?: number;
    benchmarkScore?: number;
    versions: string[];
};

export type Context7CodeSnippet = {
    codeTitle: string;
    codeList: {
        code: string;
        path?: string;
        language?: string;
    }[];
};

export type Context7InfoSnippet = {
    title: string;
    content: string;
};

export type Context7SearchResult = {
    query: string;
    libraryName: string;
    results: Context7Library[];
};


// 上游 context7 API 可能不返回页面标题（值为 "Unknown" 或缺失），
// 此时用 codeId（GitHub 原文链接）的最后一段文件名作为 fallback 标题；
// 若 URL 也提取不出，则省略 pageTitle 字段，避免输出无意义噪音。
export type Context7RawCodeSnippet = Context7CodeSnippet & {
    pageTitle?: string;
    codeId?: string;
};

export function extractTitleFromCodeId(codeId: string | undefined): string | undefined {
    if (!codeId) {
        return undefined;
    }
    try {
        const last = codeId.split('/').filter(Boolean).pop();
        if (!last) {
            return undefined;
        }
        const name = last.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
        return name || undefined;
    }
    catch {
        return undefined;
    }
}

export function normalizeCodeSnippetPageTitle(snippet: Context7RawCodeSnippet): Context7RawCodeSnippet {
    const { pageTitle, ...rest } = snippet;
    if (pageTitle && pageTitle !== 'Unknown') {
        return snippet;
    }
    const fallback = extractTitleFromCodeId(snippet.codeId);
    if (fallback) {
        return { ...rest, pageTitle: fallback };
    }
    // 提取不到：省略 pageTitle 字段
    return rest;
}
export type Context7DocsResult = {
    libraryId: string;
    query: string;
    codeSnippets: Context7CodeSnippet[];
    infoSnippets: Context7InfoSnippet[];
    /** 若库 ID 发生 301 重定向，指向新的库 ID */
    redirectUrl?: string;
};

function getApiKey(): string | undefined {
    const key = process.env.CONTEXT7_API_KEY || '';
    return key.trim() || undefined;
}

function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'User-Agent': 'MyWebSearch/2.1 (MCP; context7-integration)'
    };
    const apiKey = getApiKey();
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

function context7RequestOptions(forceDirect: boolean): any {
    return buildAxiosRequestOptions({
        headers: buildHeaders(),
        timeout: 20000,
        responseType: 'json',
        validateStatus: (status) => status >= 200 && status < 300,
        forceDirect
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 429 / 配额耗尽处理 ----
// context7 匿名配额（200 次/月，按出口 IP 计）用尽时返回：
//   HTTP 429 + body {"error":"Quota Exceeded","message":"Monthly quota exceeded..."}
//   且带 ratelimit-remaining: 0 与超长 retry-after（实测 499415s ≈ 5.8 天，直到月度重置）。
// 两条必须的防护：
// 1) 等待封顶：曾因盲从 Retry-After 而 `await sleep(499415000)`，调用挂死数天；
// 2) 配额耗尽属终态：重置前重试必然失败，直接快速失败并给出可行动提示。
const RETRY_AFTER_CAP_MS = 2000;
const QUOTA_RETRY_AFTER_THRESHOLD_S = 3600;

/** 配额耗尽终态错误的稳定标识（工具层据此选择对应 Hint） */
export const CONTEXT7_QUOTA_EXHAUSTED_MARKER = 'Context7 anonymous quota exhausted';

type Context7ErrorResponse = {
    status?: number;
    data?: unknown;
    headers?: Record<string, unknown>;
};

function readHeaderNumber(headers: Record<string, unknown> | undefined, name: string): number | undefined {
    const raw = headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function isQuotaExhaustedResponse(response: Context7ErrorResponse): boolean {
    if (response.status !== 429) {
        return false;
    }
    const data = response.data;
    const bodyText = typeof data === 'string'
        ? data
        : `${(data as { error?: unknown } | null)?.error ?? ''} ${(data as { message?: unknown } | null)?.message ?? ''}`;
    if (/quota exceeded|monthly quota/i.test(bodyText)) {
        return true;
    }
    // 无 body 时的兜底判据：配额已归零 + 重试窗口长到不像瞬时限流
    const remaining = readHeaderNumber(response.headers, 'ratelimit-remaining');
    const retryAfter = readHeaderNumber(response.headers, 'retry-after');
    return remaining === 0 && retryAfter !== undefined && retryAfter > QUOTA_RETRY_AFTER_THRESHOLD_S;
}

/**
 * 配额耗尽判定：兼容"上游 429 原始错误"与"已转换的终态 Error"两种形态，
 * 供内部重试逻辑与工具层 Hint 复用。
 */
export function isContext7QuotaExhaustedError(error: unknown): boolean {
    const response = (error as { response?: Context7ErrorResponse } | undefined)?.response;
    if (response && isQuotaExhaustedResponse(response)) {
        return true;
    }
    return error instanceof Error && error.message.includes(CONTEXT7_QUOTA_EXHAUSTED_MARKER);
}

/** 重试等待：尊重 Retry-After 但封顶；无该头时指数退避（含抖动，避免多请求同拍重试） */
export function computeContext7RetryDelayMs(retryAfterSeconds: number | undefined, attempt: number, baseMs: number): number {
    if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
        return Math.min(retryAfterSeconds * 1000, RETRY_AFTER_CAP_MS);
    }
    return baseMs * (2 ** attempt) + Math.random() * 250;
}

function buildQuotaExhaustedError(error: unknown): Error {
    const response = (error as { response?: Context7ErrorResponse } | undefined)?.response;
    const resetEpoch = readHeaderNumber(response?.headers, 'ratelimit-reset');
    const resetHint = resetEpoch !== undefined && resetEpoch > 0
        ? ` Quota resets on ${new Date(resetEpoch * 1000).toISOString().slice(0, 10)} (UTC).`
        : '';
    return new Error(
        `${CONTEXT7_QUOTA_EXHAUSTED_MARKER} (200 requests/month per egress IP).${resetHint}`
        + ' Set CONTEXT7_API_KEY for higher limits (free key: https://context7.com/dashboard).'
    );
}

/** 可注入的 GET 实现：生产走 requestDirectFirst，测试用假实现验证重试/退避策略 */
export type Context7GetImpl = (url: string, params: Record<string, unknown> | undefined) => Promise<any>;

function defaultContext7Get(url: string, params: Record<string, unknown> | undefined): Promise<any> {
    return requestDirectFirst(
        'GET',
        url,
        (forceDirect) => ({
            ...context7RequestOptions(forceDirect),
            params
        }),
        'context7 API'
    );
}

/**
 * 带退避重试的 context7 GET：429（限流）与 5xx（上游故障）最多重试 2 次并尊重 Retry-After。
 * 无 API key 时低速率限流（429）是预期失败模式，重试耗尽后转成带明确提示的错误，
 * 而不是和 5xx 一样笼统报"Failed to fetch docs"。
 *
 * 请求走"直连优先、代理兜底"（requestDirectFirst）：context7 API 国内直连可达
 * （无需代理），配置了代理但代理不可达时不会被卡死——先直连成功即返回。
 *
 * 配额耗尽（月度匿名额度用尽）是终态：不重试，立即抛出带重置日期与配置指引的错误。
 */
export async function context7GetWithRetry(
    url: string,
    options: { params?: Record<string, unknown> },
    retries = 3,
    getImpl: Context7GetImpl = defaultContext7Get
): Promise<any> {
    let lastError: any;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            return await getImpl(url, options.params);
        } catch (error: any) {
            lastError = error;
            if (isContext7QuotaExhaustedError(error)) {
                throw buildQuotaExhaustedError(error);
            }
            const status = error?.response?.status;
            if (status !== 429 && (status === undefined || status < 500)) {
                throw error; // 非限流、非上游故障：直接抛
            }
            if (attempt >= retries - 1) {
                break;
            }
            const retryAfter = readHeaderNumber(error?.response?.headers, 'retry-after');
            const base = status === 429 ? 1500 : 800;
            await sleep(computeContext7RetryDelayMs(retryAfter, attempt, base));
        }
    }
    if (lastError?.response?.status === 429) {
        throw new Error('Context7 API rate limit reached (429). Retry later, or set CONTEXT7_API_KEY for higher rate limits.');
    }
    throw lastError;
}

/**
 * 按库名搜索 context7 索引，返回匹配的库（含信誉/质量评分）。
 */
export async function searchContext7Libraries(
    libraryName: string,
    query: string | undefined,
    limit: number = 5
): Promise<Context7SearchResult> {
    const cleanLibraryName = libraryName.trim();
    if (!cleanLibraryName) {
        throw new Error('Library name cannot be empty');
    }
    const cleanQuery = (query ?? '').trim();

    const url = `${CONTEXT7_BASE_URL}/api/${CONTEXT7_API_VERSION}/libs/search`;
    const response = await context7GetWithRetry(url, {
        params: {
            libraryName: cleanLibraryName,
            query: cleanQuery || cleanLibraryName
        }
    });

    const data = response.data as { results?: Context7Library[] };
    return {
        query: cleanQuery,
        libraryName: cleanLibraryName,
        results: (data.results ?? []).slice(0, limit)
    };
}

/**
 * 获取某个库的文档片段（代码示例 + 说明文本）。
 * libraryId 形如 /vercel/next.js、/packages/express 或带版本 /vercel/next.js@v15.1.8。
 */
export async function fetchContext7Docs(
    libraryId: string,
    query: string | undefined,
    limit: number = 5
): Promise<Context7DocsResult> {
    const cleanLibraryId = libraryId.trim();
    if (!cleanLibraryId) {
        throw new Error('Library ID cannot be empty');
    }
    if (!cleanLibraryId.startsWith('/')) {
        throw new Error('Library ID must start with "/" (e.g. /vercel/next.js)');
    }
    const cleanQuery = (query ?? '').trim();

    const url = `${CONTEXT7_BASE_URL}/api/${CONTEXT7_API_VERSION}/context`;
    const response = await context7GetWithRetry(url, {
        params: {
            libraryId: cleanLibraryId,
            query: cleanQuery || 'overview',
            type: 'json'
        }
    });

    const data = response.data as {
        codeSnippets?: Context7CodeSnippet[];
        infoSnippets?: Context7InfoSnippet[];
        redirectUrl?: string;
    };

    return {
        libraryId: cleanLibraryId,
        query: cleanQuery,
        codeSnippets: (data.codeSnippets ?? []).slice(0, limit).map((snippet) => normalizeCodeSnippetPageTitle(snippet as Context7RawCodeSnippet)),
        infoSnippets: (data.infoSnippets ?? []).slice(0, limit),
        ...(data.redirectUrl ? { redirectUrl: data.redirectUrl } : {})
    };
}
