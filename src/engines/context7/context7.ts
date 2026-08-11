/**
 * Context7 文档检索客户端。
 *
 * 直接调用 context7 的公开 REST API（https://context7.com/docs/api-guide），
 * 让 open-websearch 具备"官方文档直达 + 来源信誉评分"的能力，无需依赖
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
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

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
        'User-Agent': 'OpenWebSearch/2.1 (MCP; context7-integration)'
    };
    const apiKey = getApiKey();
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

function context7RequestOptions(): any {
    return buildAxiosRequestOptions({
        headers: buildHeaders(),
        timeout: 20000,
        responseType: 'json',
        validateStatus: (status) => status >= 200 && status < 300
    });
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
    const response = await axios.get(url, {
        ...context7RequestOptions(),
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
    const response = await axios.get(url, {
        ...context7RequestOptions(),
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
