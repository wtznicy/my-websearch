import axios from 'axios';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from "../../utils/httpRequest.js";

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
async function searchExaOfficial(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
    const requestOptions = buildAxiosRequestOptions({ engine: 'exa',
        trustedStaticHost: true,
        headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json"
        }
    });

    const data = {
        query,
        numResults: limit,
        type: "auto",
        useAutoprompt: true,
        contents: {
            text: true,
            highlights: false
        }
    };

    const response = await axios.post<{ results: ExaResult[] }>(
        `https://api.exa.ai/search`,
        data,
        requestOptions
    );

    const apiResults = response.data.results;
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

/** 清洗 Exa 正文摘要：剥 HTML 标签、解码实体、压缩空白、限长 */
function cleanExaDescription(text: string): string {
    const stripped = text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-zA-Z#0-9]+;/g, (entity) => {
            const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
            return named[entity] ?? ' ';
        })
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.substring(0, 500);
}

export async function searchExa(query: string, limit: number): Promise<SearchResult[]> {
    const apiKey = process.env.EXA_API_KEY?.trim();
    if (!apiKey) {
        // 旧版免 key 的网页端内部端点（exa.ai/search/api/search-fast）自 2026-08 起已失效（返回 500）。
        // 无 key 直接报"需配置 key"并给出获取地址；标记不可重试——配置缺失是确定性错误，
        // 多引擎搜索（如 bing+exa）时 exa 立即失败，不影响其他引擎。
        const error = new Error(
            'Exa engine requires EXA_API_KEY to be configured. Get a free key at https://dashboard.exa.ai/api-keys, ' +
            'or use other engines (bing/baidu/csdn/juejin/sogou/duckduckgo/brave/startpage).'
        );
        (error as any).retryable = false;
        throw error;
    }
    return searchExaOfficial(query, limit, apiKey);
}
