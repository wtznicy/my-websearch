import axios from 'axios';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from "../../utils/httpRequest.js";
import { AppError } from '../../core/errors.js';

interface ExaResult {
    id: string;
    title: string;
    url: string;
    publishedDate?: string;
    author?: string;
    text?: string;
}

// exa.ai 官方搜索 API（需 EXA_API_KEY）。官方文档: https://docs.exa.ai/reference/search
// 响应示例: { "results": [{ "id": "...", "url": "...", "title": "...", "publishedDate": "...", "author": "...", "text": "...", "score": 0.99 }] }
async function searchExaOfficial(query: string, limit: number, apiKey: string, signal?: AbortSignal, timeRange?: 'day' | 'week' | 'month' | 'year'): Promise<SearchResult[]> {
    const requestOptions = buildAxiosRequestOptions({ engine: 'exa',
        trustedStaticHost: true,
        signal,
        headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json"
        }
    });

    const data: Record<string, unknown> = {
        query,
        numResults: limit,
        type: "auto",
        useAutoprompt: true,
        contents: {
            text: true,
            highlights: false
        }
    };

    if (timeRange) {
        const offsets = {
            day: 24 * 60 * 60 * 1000,
            week: 7 * 24 * 60 * 60 * 1000,
            month: 30 * 24 * 60 * 60 * 1000,
            year: 365 * 24 * 60 * 60 * 1000
        };
        data.startPublishedDate = new Date(Date.now() - offsets[timeRange]).toISOString();
    }

    try {
        const response = await axios.post<{ results: ExaResult[] }>(
            `https://api.exa.ai/search`,
            data,
            requestOptions
        );

        return parseExaResults(response.data.results, limit);
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/ECONNRESET|socket hang up|ECONNABORTED|ETIMEDOUT/i.test(msg) && !signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            const retryResponse = await axios.post<{ results: ExaResult[] }>(
                `https://api.exa.ai/search`,
                data,
                requestOptions
            );
            return parseExaResults(retryResponse.data.results, limit);
        }
        throw error;
    }
}

/** 清洗 Exa 正文摘要：剥 HTML 标签、解码实体、压缩空白、限长（正文常为整段数百字，截断到 ~300 字控制 token 成本） */
export function cleanExaDescription(text: string): string {
    const stripped = text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-zA-Z#0-9]+;/g, (entity) => {
            const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
            return named[entity] ?? ' ';
        })
        .replace(/\s+/g, ' ')
        .trim();
    // 按 Unicode 码点截断（Array.from 不会劈开 emoji 等代理对，substring 会产出乱码字符）
    return Array.from(stripped).slice(0, 300).join('');
}

/** 把 Exa API 结果映射为 SearchResult（标题/正文/来源处理），供请求路径复用 */
export function parseExaResults(apiResults: ExaResult[], limit: number): SearchResult[] {
    if (!apiResults || apiResults.length === 0) {
        console.error('⚠️ No results returned from Exa.ai official API.');
        return [];
    }

    return apiResults.slice(0, limit).map((item: ExaResult) => ({
        title: item.title || 'No title',
        url: item.url,
        // 官方 API 带正文时优先用正文，否则退回 Author/Published 摘要。
        // 正文可能含 HTML 标签（<b>、<em> 等），统一清洗为纯文本。
        description: item.text
            ? cleanExaDescription(item.text)
            : `Author: ${item.author || 'N/A'}. Published: ${item.publishedDate ? new Date(item.publishedDate).toLocaleDateString() : 'N/A'}`,
        source: new URL(item.url).hostname,
        engine: 'exa'
    }));
}

export async function searchExa(query: string, limit: number, options?: { signal?: AbortSignal; timeRange?: 'day' | 'week' | 'month' | 'year' }): Promise<SearchResult[]> {
    const apiKey = process.env.EXA_API_KEY?.trim();
    if (!apiKey) {
        // 旧版免 key 的网页端内部端点（exa.ai/search/api/search-fast）自 2026-08 起已失效（返回 500）。
        // 无 key 直接抛出结构化 AppError；标记不可重试——配置缺失是确定性错误，
        // 多引擎搜索（如 bing+exa）时 exa 立即失败，不影响其他引擎。
        throw new AppError({
            code: 'missing_api_key',
            retryable: false,
            status: 400,
            engine: 'exa',
            hint: 'Configure EXA_API_KEY (https://dashboard.exa.ai/api-keys) or use other engines.',
            message:
                'Exa engine requires EXA_API_KEY to be configured. Get a free key at https://dashboard.exa.ai/api-keys, ' +
                'or use other engines (bing/baidu/csdn/juejin/sogou/duckduckgo/brave/startpage).'
        });
    }
    return searchExaOfficial(query, limit, apiKey, options?.signal, options?.timeRange);
}
