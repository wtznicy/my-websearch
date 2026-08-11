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
    const requestOptions = buildAxiosRequestOptions({
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

// exa.ai 网页版内部端点（免 key，供无 EXA_API_KEY 时降级使用）。
// 注意：上游 exa.ai 前端重构后该端点可能返回 HTML/失效（2026-08 实测已失效），
// 无 key 场景大概率拿不到结果——仅作为尽力而为的 fallback。
async function searchExaLegacy(query: string, limit: number): Promise<SearchResult[]> {
    const requestOptions = buildAxiosRequestOptions({
        trustedStaticHost: true,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
            "Connection": "keep-alive",
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": "\"Chromium\";v=\"133\", \"Google Chrome\";v=\"133\", \"Not:A-Brand\";v=\"99\"",
            "content-type": "text/plain;charset=UTF-8",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "origin": "https://exa.ai",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
    });

    // The payload for the POST request
    const data = {
        "numResults": limit,
        "query": query,
        "type": "auto",
        "useAutoprompt": true,
        "domainFilterType": "include",
        "text": true,
        "density": "compact",
        "resolvedSearchType": "neural",
        "moderation": true,
        "fastMode": false,
        "rerankerType": "default"
    };

    const response = await axios.post<{ results: ExaResult[] }>(
        `https://exa.ai/search/api/search-fast`,
        data,
        requestOptions
    );

    const apiResults = response.data.results;

    if (!apiResults || apiResults.length === 0) {
        console.error('⚠️ No results returned from Exa.ai API.');
        return [];
    }

    const allResults: SearchResult[] = apiResults.map((item: ExaResult) => {
        return {
            title: item.title || 'No title',
            url: item.url,
            description: `Author: ${item.author || 'N/A'}. Published: ${item.publishedDate ? new Date(item.publishedDate).toLocaleDateString() : 'N/A'}`,
            source: new URL(item.url).hostname,
            engine: 'exa'
        };
    });

    return allResults.slice(0, limit);
}

export async function searchExa(query: string, limit: number): Promise<SearchResult[]> {
    const apiKey = process.env.EXA_API_KEY?.trim();
    if (apiKey) {
        return searchExaOfficial(query, limit, apiKey);
    }
    return searchExaLegacy(query, limit);
}
