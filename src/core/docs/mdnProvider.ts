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

/** 查询 MDN 官方 Search API */
export async function searchMdn(query: string, signal?: AbortSignal): Promise<MdnDocumentItem[]> {
    try {
        const url = `${MDN_SEARCH_URL}?q=${encodeURIComponent(query)}`;
        const res = await requestDirectFirst(
            'GET',
            url,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 5000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            `MDN search for ${query}`
        );

        if (res.status === 200 && res.data && Array.isArray((res.data as MdnSearchResponse).documents)) {
            return (res.data as MdnSearchResponse).documents;
        }
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

    const topDoc = docs[0]!;
    const docUrl = topDoc.mdn_url.startsWith('http')
        ? topDoc.mdn_url
        : `${MDN_HOST}${topDoc.mdn_url.startsWith('/') ? '' : '/'}${topDoc.mdn_url}`;

    logTool(`MDN matched top document: "${topDoc.title}" -> ${docUrl}`);
    const content = await options.fetchWeb(docUrl);
    if (!content || content.trim().length < 20) {
        return null;
    }

    const alternatives = docs.slice(1, 6).map((d) => ({
        title: d.title,
        url: d.mdn_url.startsWith('http') ? d.mdn_url : `${MDN_HOST}${d.mdn_url}`
    }));

    return {
        source: 'mdn',
        libraryId: topDoc.title,
        documentationUrl: docUrl,
        content: content.trim(),
        summary: topDoc.summary,
        alternativeEntries: alternatives.length > 0 ? alternatives : undefined
    };
}
