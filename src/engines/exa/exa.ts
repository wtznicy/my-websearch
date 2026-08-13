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
        // 官方 API 带正文时优先用正文，否则退回 Author/Published 摘要
        description: item.text
            ? item.text.trim().substring(0, 500)
            : `Author: ${item.author || 'N/A'}. Published: ${item.publishedDate ? new Date(item.publishedDate).toLocaleDateString() : 'N/A'}`,
        source: new URL(item.url).hostname,
        engine: 'exa'
    }));
}

export async function searchExa(query: string, limit: number): Promise<SearchResult[]> {
    const apiKey = process.env.EXA_API_KEY?.trim();
    if (!apiKey) {
        // 旧版免 key 的网页端内部端点（exa.ai/search/api/search-fast）自 2026-08 起已失效（返回 500）。
        // 无 key 直接给出明确配置指引，避免每次调用都白打失效端点并触发多层重试。
        throw new Error(
            'Exa engine requires EXA_API_KEY. Get one at https://dashboard.exa.ai/api-keys, ' +
            'then set it in your MCP client server env (e.g. "EXA_API_KEY": "<your-key>" in Claude Desktop / Cherry Studio / ZCode MCP config), ' +
            'or run the CLI with the env prefix: EXA_API_KEY=<your-key> open-websearch search ...'
        );
    }
    return searchExaOfficial(query, limit, apiKey);
}
