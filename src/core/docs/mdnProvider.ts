/**
 * MDN Web Docs 官方 API 与 Web 标准文档检索器。
 *
 * 官方搜索 API:
 * GET https://developer.mozilla.org/api/v1/search?q=<query>
 *
 * 覆盖：
 * - Web APIs（Fetch, WebSocket, Canvas, WebGL, ServiceWorker, DOM, WebRTC 等）
 * - JavaScript 标准库（Array, Promise, Object, Map, RegExp, Proxy 等）
 * - HTML 元素与属性规范
 * - CSS 属性与选择器规范
 */

import { requestDirectFirst, buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { logSafeError, logTool } from '../../tools/toolShared.js';

export interface MdnDocumentItem {
    title: string;
    mdn_url: string;
    summary: string;
}

export interface MdnSearchResponse {
    documents: MdnDocumentItem[];
}

export interface MdnResult {
    source: 'mdn';
    libraryId: string;
    documentationUrl: string;
    content: string;
    summary?: string;
    confidence?: 'high' | 'medium' | 'low';
    warnings?: string[];
    alternativeEntries?: Array<{ title: string; url: string }>;
}

const MDN_SEARCH_URL = 'https://developer.mozilla.org/api/v1/search';
const MDN_HOST = 'https://developer.mozilla.org';

const COMMON_MDN_PATTERNS = [
    /^mdn:/i,
    /^(?:html|css|webapi|dom):/i,
    /^(?:javascript|ecmascript|css|html5?)$/i,
    /^(?:fetch|websocket|canvas|webgl|indexeddb|serviceworker|webrtc|localstorage|sessionstorage)$/i,
    /\.(?:prototype|addEventListener|querySelector|getElementById)\b/i
];

/** 判断给定目标是否应当路由到 MDN */
export function isLikelyMdnTarget(target: string): boolean {
    const clean = target.trim().toLowerCase();
    return COMMON_MDN_PATTERNS.some((pattern) => pattern.test(clean));
}

/** 规范化 MDN 查询词 */
export function extractMdnQuery(library: string, query?: string): string {
    const cleanLib = library.trim().replace(/^(?:mdn|html|css|webapi|dom):/i, '').trim();
    if (!query || !query.trim()) {
        return cleanLib;
    }
    const cleanQuery = query.trim();
    if (cleanLib && !cleanQuery.toLowerCase().includes(cleanLib.toLowerCase())) {
        return `${cleanLib} ${cleanQuery}`.trim();
    }
    return cleanQuery;
}

/** 查询 MDN 官方 Search API（支持中文与多语言本地化） */
export async function searchMdn(query: string, signal?: AbortSignal, locale?: 'zh-CN' | 'en-US'): Promise<MdnDocumentItem[]> {
    const hasChinese = /[\u4e00-\u9fa5]/.test(query);
    const targetLocale = locale ?? (hasChinese ? 'zh-CN' : undefined);

    const doSearch = async (loc?: string): Promise<MdnDocumentItem[]> => {
        const queryParam = loc ? `q=${encodeURIComponent(query)}&locale=${encodeURIComponent(loc)}` : `q=${encodeURIComponent(query)}`;
        const url = `${MDN_SEARCH_URL}?${queryParam}`;
        const res = await requestDirectFirst(
            'GET',
            url,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 5000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            `MDN search for ${query} (${loc ?? 'default'})`
        );

        if (res.status === 200 && res.data && Array.isArray((res.data as MdnSearchResponse).documents)) {
            return (res.data as MdnSearchResponse).documents;
        }
        return [];
    };

    try {
        if (targetLocale) {
            const localized = await doSearch(targetLocale);
            if (localized.length > 0) {
                return localized;
            }
        }
        return await doSearch();
    } catch (err) {
        logSafeError(`MDN search failed for "${query}"`, err);
    }
    return [];
}

/** 核心入口：检索并拉取 MDN Markdown 文档 */
export async function queryMdnDocs(options: {
    library: string;
    query?: string;
    signal?: AbortSignal;
    fetchWeb: (url: string) => Promise<string | null>;
}): Promise<MdnResult | null> {
    const searchTerm = extractMdnQuery(options.library, options.query);
    if (!searchTerm) return null;

    logTool(`Querying MDN for: "${searchTerm}"`);
    const docs = await searchMdn(searchTerm, options.signal);
    if (docs.length === 0) return null;

    const cleanLib = options.library.trim().replace(/^(?:mdn|html|css|webapi|dom):/i, '').trim().toLowerCase();
    const cleanQuery = (options.query ?? '').trim().toLowerCase();
    const queryTokens = cleanQuery.split(/[\s,:+/-]+/).filter((t) => t.length >= 2);

    // 候选相关性加权打分：优先挑选标题/URL 与目标库名/API 名（如 "fetch"）精确契合的文档，
    // 避免因为 query 中含有泛词（如 "request options"）误把无关的 HTTP OPTIONS 方法页当成第一名。
    function scoreMdnDoc(doc: MdnDocumentItem): number {
        let score = 0;
        const lowerTitle = doc.title.toLowerCase();
        const lowerUrl = doc.mdn_url.toLowerCase();
        const lowerSummary = (doc.summary ?? '').toLowerCase();

        if (cleanLib) {
            if (lowerTitle === cleanLib || lowerTitle.startsWith(`${cleanLib}()`) || lowerTitle.startsWith(`${cleanLib}:`)) {
                score += 100;
            } else if (lowerTitle.includes(cleanLib)) {
                score += 60;
            } else if (lowerUrl.includes(`/${cleanLib}`) || lowerUrl.includes(`_${cleanLib}`)) {
                score += 40;
            }
        }

        for (const token of queryTokens) {
            if (lowerTitle.includes(token)) score += 20;
            if (lowerSummary.includes(token)) score += 5;
        }

        return score;
    }

    const scoredDocs = docs.map((doc, index) => ({ doc, score: scoreMdnDoc(doc), originalIndex: index }));
    scoredDocs.sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);

    const topDoc = scoredDocs[0]!.doc;
    const hasLibMatch = cleanLib ? (topDoc.title.toLowerCase().includes(cleanLib) || topDoc.mdn_url.toLowerCase().includes(cleanLib)) : true;
    const confidence: 'high' | 'medium' | 'low' = hasLibMatch ? 'high' : 'medium';
    const warnings: string[] = [];
    if (!hasLibMatch && cleanLib) {
        warnings.push(`Top MDN result "${topDoc.title}" did not directly match requested API "${cleanLib}".`);
    }

    const docUrl = topDoc.mdn_url.startsWith('http')
        ? topDoc.mdn_url
        : `${MDN_HOST}${topDoc.mdn_url.startsWith('/') ? '' : '/'}${topDoc.mdn_url}`;

    logTool(`MDN matched top document: "${topDoc.title}" (score: ${scoredDocs[0]!.score}) -> ${docUrl}`);
    const content = await options.fetchWeb(docUrl);
    if (!content || content.trim().length < 20) {
        return null;
    }

    const alternatives = scoredDocs.slice(1, 6).map((item) => ({
        title: item.doc.title,
        url: item.doc.mdn_url.startsWith('http') ? item.doc.mdn_url : `${MDN_HOST}${item.doc.mdn_url}`
    }));

    return {
        source: 'mdn',
        libraryId: topDoc.title,
        documentationUrl: docUrl,
        content: content.trim(),
        summary: topDoc.summary,
        confidence,
        warnings: warnings.length > 0 ? warnings : undefined,
        alternativeEntries: alternatives.length > 0 ? alternatives : undefined
    };
}
