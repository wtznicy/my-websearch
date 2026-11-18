import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { engineShouldUseProxy, getProxyUrl } from '../../config.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { detectSystemProxy } from '../../utils/systemProxy.js';
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { AppError } from '../../core/errors.js';
import { assertOverseasEngineUsable } from '../../utils/overseasProbe.js';
import { createWreqSession, loadWreqModule } from '../bing/impersonate.js';
import { isTlsOrWafResetError } from '../../utils/domesticDirectNetwork.js';

const YAHOO_HOME = 'https://search.yahoo.com/';
const YAHOO_SEARCH = 'https://search.yahoo.com/search';
const YAHOO_HOME_TIMEOUT_MS = 3500;
const YAHOO_SEARCH_TIMEOUT_MS = 8000;
const PAGE_SIZE = 10;
const MAX_PAGES = 3;

type WreqSession = Awaited<ReturnType<typeof createWreqSession>>;

let cachedYahooSession: WreqSession | null = null;
let yahooSessionPromise: Promise<WreqSession | null> | null = null;
let cachedYahooProxy: string | undefined = undefined;
let yahooSessionWarmedUp = false;

export function hasYahooSessionCookie(cookies: Array<{ name?: string }>): boolean {
    return cookies.some(c => Boolean(c.name && /^(A1|A3|lkl|B|BX)$/i.test(c.name)));
}

export async function invalidateYahooSession(): Promise<void> {
    const session = cachedYahooSession;
    cachedYahooSession = null;
    yahooSessionPromise = null;
    yahooSessionWarmedUp = false;
    if (session) {
        try {
            await session.close();
        } catch {
            // ignore close error
        }
    }
}

export function __resetYahooSessionForTests(): Promise<void> {
    return invalidateYahooSession();
}

function isProxyOrNetworkFatalError(error: unknown): boolean {
    if (isTlsOrWafResetError(error)) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /unexpected EOF|socket hang up|ECONNRESET|client error \(Connect\)|handshake.*failed|operation timed out/i.test(message);
}

export const __isProxyOrNetworkFatalErrorForTests = isProxyOrNetworkFatalError;

const YAHOO_HEADERS: Record<string, string> = {
    'User-Agent': BROWSER_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1'
};

/**
 * Yahoo 的结果链接是 `r.search.yahoo.com/.../RU=<percent-encoded target>/RK=...`，
 * 直接交给 URL 校验会落到 yahoo.com 的跳转页；这里还原成真实目标。
 */
export function extractYahooResultUrl(href: string): string {
    if (!href) {
        return '';
    }
    const candidate = href.trim();
    if (/r\.search\.yahoo\.com/i.test(candidate)) {
        const match = candidate.match(/\/RU=([^/]+)/i);
        const encoded = match?.[1];
        if (encoded) {
            try {
                return decodeURIComponent(encoded);
            } catch {
                return encoded;
            }
        }
    }
    return candidate;
}

export interface YahooParseResult {
    results: SearchResult[];
    rawCount: number;
}

/** 解析 Yahoo SSR 结果页：结果块是 `div.algo`，标题在 `h3 a`，摘要通常带 `.compText`。 */
export function parseYahooHtmlResults(html: string, maxResults: number, seenUrls: Set<string>): YahooParseResult {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    let rawCount = 0;

    $('div.algo').each((_, el) => {
        rawCount += 1;
        if (results.length >= maxResults) {
            return false;
        }

        // Yahoo 把标题放在 h3 里，但 <a> 在 h3 外层（.compTitle > a），不能写 h3 a。
        const titleEl = $(el).find('h3').first();
        const linkEl = $(el).find('.compTitle a[href]').first();
        const title = titleEl.text().trim() || linkEl.text().trim();
        const url = extractYahooResultUrl(linkEl.attr('href') || '');
        const description = $(el).find('.compText').first().text().trim();
        const source = (() => {
            try {
                return new URL(url).hostname;
            } catch {
                return '';
            }
        })();

        if (!title || !url.startsWith('http') || seenUrls.has(url)) {
            return;
        }

        seenUrls.add(url);
        results.push({
            title,
            url,
            description,
            source,
            engine: 'yahoo'
        });
    });

    return { results, rawCount };
}

function collectCookiePairs(setCookie: unknown, jar: Map<string, string>): void {
    const raw = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
    for (const entry of raw) {
        const pair = entry.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) {
            jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }
}

function cookieHeader(jar: Map<string, string>): string {
    return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

function buildSearchUrl(query: string, page: number, timeRange?: 'day' | 'week' | 'month' | 'year'): string {
    const params = new URLSearchParams({
        p: query,
        b: String(1 + page * PAGE_SIZE),
        ei: 'UTF-8'
    });
    const freshness: Record<string, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };
    if (timeRange && freshness[timeRange]) {
        params.set('btf', freshness[timeRange]);
    }
    return `${YAHOO_SEARCH}?${params.toString()}`;
}

async function getOrCreateYahooSession(mod: NonNullable<Awaited<ReturnType<typeof loadWreqModule>>>): Promise<WreqSession | null> {
    const explicitProxy = engineShouldUseProxy('yahoo') ? getProxyUrl() : undefined;
    const proxy = explicitProxy ?? (await detectSystemProxy()) ?? undefined;

    if (cachedYahooSession && cachedYahooProxy === proxy) {
        return cachedYahooSession;
    }

    if (yahooSessionPromise) {
        return yahooSessionPromise;
    }

    yahooSessionPromise = (async () => {
        if (cachedYahooSession) {
            await invalidateYahooSession();
        }
        cachedYahooProxy = proxy;
        const session = await createWreqSession(mod, 'yahoo', proxy ?? undefined);
        cachedYahooSession = session;
        yahooSessionWarmedUp = false;
        return session;
    })();

    try {
        return await yahooSessionPromise;
    } finally {
        yahooSessionPromise = null;
    }
}

async function fetchYahooWithWreq(query: string, limit: number, signal?: AbortSignal, timeRange?: 'day' | 'week' | 'month' | 'year'): Promise<SearchResult[] | null> {
    if (signal?.aborted) {
        return null;
    }
    try {
        const mod = await loadWreqModule();
        if (!mod) {
            return null;
        }

        const session = await getOrCreateYahooSession(mod);
        if (!session) {
            return null;
        }

        let hasCookies = false;
        try {
            const cookies = session.getAllCookies();
            hasCookies = hasYahooSessionCookie(cookies);
        } catch {
            hasCookies = false;
        }

        // 仅在首次启动或尚未获得关键 Cookie 时执行首页预热，避免每次搜索重复消耗 1.5s~3.5s
        if (!yahooSessionWarmedUp || !hasCookies) {
            const home = await session.fetch(YAHOO_HOME, { timeout: YAHOO_HOME_TIMEOUT_MS, headers: YAHOO_HEADERS });
            await home.text();
            if (home.status === 307) {
                await invalidateYahooSession();
                throw new AppError({
                    code: 'overseas_unreachable',
                    retryable: false,
                    status: 307,
                    engine: 'yahoo',
                    message: 'Yahoo homepage returned HTTP 307 (EU GDPR consent wall).',
                    hint: 'Yahoo redirected to EU consent wall (guce.yahoo.com): switch your proxy node to a non-EU region (e.g. US, JP, SG).'
                });
            }
            if (home.status !== 200) {
                await invalidateYahooSession();
                return null;
            }
            yahooSessionWarmedUp = true;
        }

        const seenUrls = new Set<string>();
        const results: SearchResult[] = [];
        const pages = Math.max(1, Math.min(MAX_PAGES, Math.ceil(limit / PAGE_SIZE)));
        for (let page = 0; page < pages && results.length < limit; page += 1) {
            if (signal?.aborted) {
                break;
            }
            const response = await session.fetch(buildSearchUrl(query, page, timeRange), {
                timeout: YAHOO_SEARCH_TIMEOUT_MS,
                headers: YAHOO_HEADERS
            });
            if (response.status === 307) {
                await invalidateYahooSession();
                throw new AppError({
                    code: 'overseas_unreachable',
                    retryable: false,
                    status: 307,
                    engine: 'yahoo',
                    message: 'Yahoo search returned HTTP 307 (EU GDPR consent wall).',
                    hint: 'Yahoo redirected to EU consent wall (guce.yahoo.com): switch your proxy node to a non-EU region (e.g. US, JP, SG).'
                });
            }
            if (response.status !== 200) {
                // 遇到非 200（如 500、429、403），可能 Cookie 失效或遭限流，废弃长效 Session
                await invalidateYahooSession();
                break;
            }
            const html = await response.text();
            const parsed = parseYahooHtmlResults(html, limit - results.length, seenUrls);
            results.push(...parsed.results);
            if (parsed.rawCount === 0) {
                break;
            }
        }
        return results;
    } catch (error) {
        await invalidateYahooSession();
        if (error instanceof AppError) {
            throw error;
        }
        if (isProxyOrNetworkFatalError(error)) {
            console.warn('[yahoo] wreq encountered proxy/network tunnel failure, fast-failing to trigger engine cascade:', error instanceof Error ? error.message : String(error));
            throw new AppError({
                code: 'overseas_unreachable',
                retryable: true,
                status: 503,
                engine: 'yahoo',
                message: `Yahoo proxy tunnel error: ${error instanceof Error ? error.message : String(error)}`,
                hint: 'Yahoo is unreachable via current proxy node: verify proxy settings or switch to a stable node.'
            });
        }
        console.warn('[yahoo] wreq session failed, falling back to axios:', error instanceof Error ? error.message : String(error));
        return null;
    }
}

async function fetchYahooWithAxios(query: string, limit: number, signal?: AbortSignal, timeRange?: 'day' | 'week' | 'month' | 'year'): Promise<SearchResult[]> {
    const jar = new Map<string, string>();
    const request = async (url: string, timeoutMs: number = YAHOO_SEARCH_TIMEOUT_MS): Promise<{ status: number; data: string }> => {
        const response = await axios.get<string>(url, buildAxiosRequestOptions({
            engine: 'yahoo',
            trustedStaticHost: true,
            signal,
            timeout: timeoutMs,
            responseType: 'text',
            validateStatus: () => true,
            headers: {
                ...YAHOO_HEADERS,
                ...(jar.size > 0 ? { Cookie: cookieHeader(jar) } : {})
            }
        }));
        collectCookiePairs(response.headers['set-cookie'], jar);
        return { status: response.status, data: typeof response.data === 'string' ? response.data : String(response.data) };
    };

    // Yahoo 对无 cookie 的搜索请求直接返回 500；先访问首页取得 A1/A3 等 cookie。
    // 预热超时限制为 3.5s，避免在不可达代理上空等
    let home: { status: number; data: string };
    try {
        home = await request(YAHOO_HOME, YAHOO_HOME_TIMEOUT_MS);
    } catch (homeError) {
        throw new AppError({
            code: 'overseas_unreachable',
            retryable: true,
            status: 503,
            engine: 'yahoo',
            message: `Yahoo homepage request failed: ${homeError instanceof Error ? homeError.message : String(homeError)}`,
            hint: 'Yahoo is unreachable directly from CN: enable the system proxy or PROXY_URL, and include "yahoo" in an explicit proxy.engines list.'
        });
    }

    if (home.status !== 200) {
        const isConsentWall = home.status === 307;
        throw new AppError({
            code: 'overseas_unreachable',
            retryable: !isConsentWall,
            status: isConsentWall ? 307 : 503,
            engine: 'yahoo',
            message: isConsentWall
                ? 'Yahoo homepage returned HTTP 307 (EU GDPR consent wall).'
                : `Yahoo homepage returned HTTP ${home.status}; cannot warm cookies needed by the search endpoint.`,
            hint: isConsentWall
                ? 'Yahoo redirected to EU consent wall (guce.yahoo.com): switch your proxy node to a non-EU region (e.g. US, JP, SG).'
                : 'Yahoo is unreachable directly from CN: enable the system proxy or PROXY_URL, and include "yahoo" in an explicit proxy.engines list.'
        });
    }

    const seenUrls = new Set<string>();
    const results: SearchResult[] = [];
    const pages = Math.max(1, Math.min(MAX_PAGES, Math.ceil(limit / PAGE_SIZE)));
    for (let page = 0; page < pages && results.length < limit; page += 1) {
        const response = await request(buildSearchUrl(query, page, timeRange), YAHOO_SEARCH_TIMEOUT_MS);
        if (response.status !== 200) {
            const isConsentWall = response.status === 307;
            throw new AppError({
                code: response.status === 429 || response.status === 403 ? 'bot_challenge' : 'overseas_unreachable',
                retryable: !isConsentWall,
                status: response.status,
                engine: 'yahoo',
                message: isConsentWall
                    ? 'Yahoo search returned HTTP 307 (EU GDPR consent wall).'
                    : `Yahoo search returned HTTP ${response.status}.`,
                hint: isConsentWall
                    ? 'Yahoo redirected to EU consent wall (guce.yahoo.com): switch your proxy node to a non-EU region (e.g. US, JP, SG).'
                    : 'Yahoo needs a proxy in CN; if you configured proxy.engines explicitly, add "yahoo" to it. Otherwise check the proxy and retry.'
            });
        }
        const parsed = parseYahooHtmlResults(response.data, limit - results.length, seenUrls);
        results.push(...parsed.results);
        if (parsed.rawCount === 0) {
            break;
        }
    }
    return results;
}

export async function searchYahoo(
    query: string,
    limit: number,
    options?: { signal?: AbortSignal; timeRange?: 'day' | 'week' | 'month' | 'year' }
): Promise<SearchResult[]> {
    const signal = options?.signal;
    const timeRange = options?.timeRange;

    await assertOverseasEngineUsable('yahoo');

    const viaWreq = await fetchYahooWithWreq(query, limit, signal, timeRange);
    if (viaWreq !== null) {
        return viaWreq.slice(0, limit);
    }
    if (signal?.aborted) {
        return [];
    }
    const results = await fetchYahooWithAxios(query, limit, signal, timeRange);
    return results.slice(0, limit);
}
