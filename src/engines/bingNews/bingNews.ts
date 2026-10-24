import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { AppError } from '../../core/errors.js';

const BING_NEWS_ENDPOINT = 'https://www.bing.com/news/search';
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

function cleanText(raw: string): string {
    const withCdata = raw.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    return cheerio.load(`<div>${withCdata}</div>`).text().replace(/\s+/g, ' ').trim();
}

function readTag(itemXml: string, tag: string): string {
    const match = itemXml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
    return match?.[1] ? decodeXmlEntities(match[1]).trim() : '';
}

/**
 * Bing News RSS 的 link 是 apiclick.aspx 跳转，真实目标在 `url` 查询参数里。
 * 解析失败时保留原始链接（至少可用）。
 */
export function decodeBingNewsUrl(link: string): string {
    const raw = link.trim();
    try {
        const parsed = new URL(raw);
        const target = parsed.searchParams.get('url');
        if (target) {
            const decoded = decodeURIComponent(target);
            if (/^https?:\/\//i.test(decoded)) {
                return decoded;
            }
        }
    } catch {
        // fall through
    }
    return raw;
}

export interface BingNewsParseOptions {
    now?: number;
    windowMs?: number;
    limit?: number;
}

/**
 * 解析 Bing News RSS，并按 pubDate 过滤最近 24h。
 * 解析不到日期或超出窗口的条目会被丢弃（新闻模式不返回“旧闻”）。
 */
export function parseBingNewsRss(xml: string, options: BingNewsParseOptions = {}): SearchResult[] {
    const now = options.now ?? Date.now();
    const windowMs = options.windowMs ?? WINDOW_24H_MS;
    const limit = options.limit ?? 10;
    const results: Array<SearchResult & { publishedAtMs: number }> = [];

    for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
        const itemXml = match[1] ?? '';
        const title = cleanText(readTag(itemXml, 'title'));
        const link = decodeBingNewsUrl(readTag(itemXml, 'link'));
        const description = cleanText(readTag(itemXml, 'description'));
        const pubDate = readTag(itemXml, 'pubDate');
        const publishedAtMs = Date.parse(pubDate);

        if (!title || !link.startsWith('http') || !Number.isFinite(publishedAtMs)) {
            continue;
        }
        if (publishedAtMs < now - windowMs || publishedAtMs > now + 5 * 60 * 1000) {
            continue;
        }

        let source = '';
        try {
            source = new URL(link).hostname;
        } catch {
            // ignore
        }

        results.push({
            title,
            url: link,
            description,
            source,
            engine: 'bing-news',
            publishedAtMs
        });
    }

    results.sort((a, b) => b.publishedAtMs - a.publishedAtMs);
    return results.slice(0, limit).map((result) => ({
        title: result.title,
        url: result.url,
        description: result.description,
        source: result.source,
        engine: result.engine
    }));
}

export async function searchBingNews(
    query: string,
    limit: number,
    options?: { signal?: AbortSignal }
): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, format: 'RSS' });
    const url = `${BING_NEWS_ENDPOINT}?${params.toString()}`;

    try {
        const response = await axios.get<string>(url, buildAxiosRequestOptions({
            engine: 'bing-news',
            trustedStaticHost: true,
            timeout: 10000,
            responseType: 'text',
            signal: options?.signal,
            headers: {
                'User-Agent': BROWSER_USER_AGENT,
                'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            validateStatus: () => true
        }));

        if (response.status !== 200) {
            throw new AppError({
                code: response.status === 429 ? 'rate_limited' : 'engine_error',
                retryable: response.status === 429 || response.status >= 500,
                status: response.status,
                engine: 'bing-news',
                message: `Bing News RSS returned HTTP ${response.status}`
            });
        }

        const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        if (!/<rss/i.test(body) && !/<item>/i.test(body)) {
            // www.bing.com 在部分网络会 302 到 cn.bing.com 并返回 HTML；此时 RSS 不可用
            throw new AppError({
                code: 'overseas_unreachable',
                retryable: true,
                status: 503,
                engine: 'bing-news',
                message: 'Bing News returned HTML instead of RSS (likely a 302 to cn.bing.com).',
                hint: 'Enable the proxy / PROXY_URL, or add "bing-news" to an explicit proxy.engines list; direct access is not reliable from CN.'
            });
        }
        return parseBingNewsRss(body, { limit });
    } catch (error) {
        if (error instanceof AppError) {
            throw error;
        }
        throw new AppError({
            code: 'network_error',
            retryable: true,
            engine: 'bing-news',
            message: `Bing News request failed: ${error instanceof Error ? error.message : String(error)}`
        });
    }
}
