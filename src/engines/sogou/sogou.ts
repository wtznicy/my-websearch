import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { normalizeText } from '../../utils/text.js';
import { sleep } from '../../utils/timing.js';
import { mapWithConcurrencyBudget } from '../../utils/concurrency.js';
import { createWreqSession, loadWreqModule, WreqSession } from '../bing/impersonate.js';

const SOGOU_SEARCH_URL = 'https://www.sogou.com/web';
const SOGOU_PAGE_SIZE = 10;
/** 跳转链解析总预算与并发（见 searchSogouPage） */
const SOGOU_LINK_RESOLVE_BUDGET_MS = 2000;
// 4（而非 6）：多引擎并发时保留连接预算，避免与同批次其他引擎的解析争抢导致整体超时
const SOGOU_LINK_RESOLVE_CONCURRENCY = 4;

/** 搜狗移动端接口（WAP 集群）：风控规则远宽松于 PC 端——实测同一被标记的代理 IP 上
 *  PC 端 100% 验证码拦截，移动端 200 且返回明文链接（a.resultLink 的 url= 参数），
 *  无需再做跳转链解析（PC 端每条结果一次跳转跟随的 2~3s 开销归零）。 */
const SOGOU_MOBILE_URL = 'https://m.sogou.com/web/searchList.jsp';
const SOGOU_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.sogou.com/'
};

type SogouHttpGet = (url: string, options: AxiosRequestConfig) => Promise<AxiosResponse>;

/**
 * 搜狗的会话级指纹请求（wreq-js，Chrome TLS/HTTP2 指纹）。
 * 实测：纯 axios 请求搜狗搜索页会被 WAF 直接 403；换用 TLS 指纹后 403 → 200
 * （残留的图形验证码是针对代理出口 IP 的风险控制，非请求特征层可解）。
 * Session 懒创建并复用（连接复用，第二次起约 1s/请求）。
 */
let sogouWreqSessionPromise: Promise<WreqSession | null> | null = null;

async function ensureSogouWreqSession(): Promise<WreqSession | null> {
    if (!sogouWreqSessionPromise) {
        sogouWreqSessionPromise = (async () => {
            const mod = await loadWreqModule();
            if (!mod) {
                return null;
            }
            try {
                return await createWreqSession(mod as unknown as Parameters<typeof createWreqSession>[0]);
            } catch (error) {
                console.warn('Sogou wreq session creation failed, falling back to axios:', error instanceof Error ? error.message : String(error));
                return null;
            }
        })();
    }
    return sogouWreqSessionPromise;
}

/** 把 wreq 响应转成 axios 形状（现有重定向/cookie 逻辑按 axios 响应读取） */
function toAxiosLikeResponse(
    status: number,
    headers: { forEach(cb: (value: string, key: string) => void): void; getSetCookie?(): string[] },
    data: string,
    options: AxiosRequestConfig
): AxiosResponse {
    const normalizedHeaders: Record<string, string | string[]> = {};
    headers.forEach((value, key) => {
        normalizedHeaders[key.toLowerCase()] = value;
    });
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    if (setCookies.length > 0) {
        normalizedHeaders['set-cookie'] = setCookies;
    }
    return {
        status,
        statusText: '',
        headers: normalizedHeaders,
        data,
        config: options,
        request: {}
    } as unknown as AxiosResponse;
}

async function sogouHttpGetWithImpersonate(url: string, options: AxiosRequestConfig): Promise<AxiosResponse> {
    const session = await ensureSogouWreqSession();
    if (!session) {
        throw new Error('wreq session unavailable');
    }
    // redirect: manual —— 保留 fetchSogouHtml 的手动重定向/ cookie 合并逻辑
    const response = await session.fetch(url, {
        timeout: (options.timeout as number) || 20000,
        redirect: 'manual'
    });
    const body = await response.text();
    return toAxiosLikeResponse(response.status, response.headers, body, options);
}

const defaultSogouHttpGet: SogouHttpGet = async (url, options) => {
    try {
        return await sogouHttpGetWithImpersonate(url, options);
    } catch (error) {
        console.warn('Sogou impersonate request failed, falling back to axios:', error instanceof Error ? error.message : String(error));
        return axios.get(url, options);
    }
};

let sogouHttpGet: SogouHttpGet = defaultSogouHttpGet;

export function __setSogouHttpGetForTests(impl?: SogouHttpGet): void {
    sogouHttpGet = impl ?? defaultSogouHttpGet;
}

function isSogouChallengePage(html: string): boolean {
    const normalized = html.toLowerCase();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();

    return normalized.includes('antispider')
        || normalized.includes('请输入验证码')
        || normalized.includes('访问过于频繁')
        || title.includes('搜狗搜索验证');
}

function resolveResultUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return '';
    }

    try {
        const absoluteUrl = new URL(trimmed, SOGOU_SEARCH_URL).toString();
        const parsed = new URL(absoluteUrl);
        const target = parsed.searchParams.get('url') || parsed.searchParams.get('u') || parsed.searchParams.get('link');
        if (target && /^https?:\/\//i.test(target)) {
            return target;
        }
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return absoluteUrl;
        }
    } catch {
        return '';
    }

    return '';
}

function extractSource(url: string, sourceText: string): string {
    const cleanedSource = normalizeText(sourceText);
    // sogou 跳转链的 hostname 占位不是真实来源；真实 URL 解析出来后应改用真实域名
    const isSogouPlaceholder = cleanedSource === 'sogou.com' || cleanedSource === 'www.sogou.com';
    if (cleanedSource && !isSogouPlaceholder) {
        return cleanedSource;
    }

    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

/**
 * 跟随 sogou.com/link 跳转链拿到真实目标 URL。
 * 搜狗把每个结果包成 /link?url=<加密> 的跳转链接，url 参数是加密的无法直接解出明文；
 * 且跳转不是 HTTP 3xx，而是页面内 JS 完成的（HTTP 200 + window.location.replace，
 * noscript 下是 meta refresh）。这里抓 body 里的跳转目标；失败时保留原链接，不影响整页结果。
 */
async function resolveSogouLinkUrl(linkUrl: string): Promise<string> {
    try {
        const parsed = new URL(linkUrl);
        if (!parsed.pathname.startsWith('/link')) {
            return linkUrl;
        }
    } catch {
        return linkUrl;
    }

    try {
        const response = await sogouHttpGet(linkUrl, buildAxiosRequestOptions({ engine: 'sogou',
            trustedStaticHost: true,
            headers: COMMON_HEADERS,
            timeout: 8000,
            validateStatus: (status) => status >= 200 && status < 400
        }));
        const html = String(response.data || '');
        // 跳转页格式：<script>window.location.replace("https://real-target")</script>
        // 或 <noscript><META http-equiv="refresh" content="0;URL='https://real-target'"></noscript>
        const replaceMatch = html.match(/window\.location\.replace\(\s*["']([^"']+)["']\s*\)/i);
        const refreshMatch = html.match(/http-equiv=["']refresh["'][^>]*content=["']\d*;\s*URL=['"]?([^'">\s]+)/i);
        const target = (replaceMatch?.[1] ?? refreshMatch?.[1] ?? '').trim();
        if (/^https?:\/\//i.test(target)) {
            const targetParsed = new URL(target);
            if (!isAllowedSogouRedirectUrl(targetParsed)) {
                return target;
            }
        }
    } catch {
        // 解析失败保留原链接
    }
    return linkUrl;
}

/** 限制并发数地批量解析（N+1 串行请求会拖慢整页） */
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

function isAllowedSogouRedirectUrl(url: URL): boolean {
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === 'https:' || url.protocol === 'http:')
        && (hostname === 'sogou.com' || hostname.endsWith('.sogou.com'));
}

function mergeSetCookie(cookieHeader: string, setCookie: string | string[] | undefined): string {
    if (!setCookie) {
        return cookieHeader;
    }

    const cookieMap = new Map<string, string>();
    for (const cookie of cookieHeader.split(';')) {
        const trimmed = cookie.trim();
        if (!trimmed) {
            continue;
        }
        const [name] = trimmed.split('=', 1);
        cookieMap.set(name, trimmed);
    }

    const values = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const value of values) {
        const pair = value.split(';', 1)[0]?.trim();
        if (!pair) {
            continue;
        }
        const [name] = pair.split('=', 1);
        cookieMap.set(name, pair);
    }

    return Array.from(cookieMap.values()).join('; ');
}

async function fetchSogouHtml(initialUrl: string): Promise<string> {
    let currentUrl = initialUrl;
    let cookieHeader = '';

    for (let redirects = 0; redirects <= 5; redirects += 1) {
        const response = await sogouHttpGet(currentUrl, buildAxiosRequestOptions({ engine: 'sogou',
            trustedStaticHost: true,
            headers: {
                ...COMMON_HEADERS,
                ...(cookieHeader ? { Cookie: cookieHeader } : {})
            },
            timeout: 20000,
            validateStatus: (status) => status >= 200 && status < 400
        }));

        cookieHeader = mergeSetCookie(cookieHeader, response.headers?.['set-cookie']);

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers?.location;
            if (!location) {
                throw new Error(`Sogou returned redirect status ${response.status} without a Location header`);
            }

            const redirectUrl = new URL(String(location), currentUrl);
            if (!isAllowedSogouRedirectUrl(redirectUrl)) {
                throw new Error(`Sogou redirected to an unexpected host: ${redirectUrl.hostname}`);
            }
            currentUrl = redirectUrl.toString();
            continue;
        }

        return String(response.data || '');
    }

    throw new Error('Sogou returned too many redirects');
}

/** 请求搜狗移动端结果页（独立于 PC 端路径：移动端风控宽松，不需要指纹） */
async function fetchSogouMobileHtml(query: string): Promise<string> {
    const url = `${SOGOU_MOBILE_URL}?keyword=${encodeURIComponent(query)}`;
    const response = await sogouHttpGet(url, buildAxiosRequestOptions({ engine: 'sogou',
        trustedStaticHost: true,
        headers: {
            'User-Agent': SOGOU_MOBILE_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        timeout: 15000,
        validateStatus: (status) => status >= 200 && status < 400
    }));
    return String(response.data || '');
}

/**
 * 解析搜狗移动端结果页。
 * 只保留持 `a.resultLink` 且能解出明文 `url=` 的卡片——广告/推荐位天然被过滤；
 * 真实链接直接来自 URL 参数，无需 HTTP 跟随（这是移动端路径最大的性能收益）。
 */
export function parseSogouMobileResults(html: string): SearchResult[] {
    if (isSogouChallengePage(html)) {
        throw new Error('Sogou returned a verification or anti-bot page');
    }

    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $('.vrResult').each((_, element) => {
        const card = $(element);
        const link = card.find('a.resultLink[href*="url="]').first();
        const href = String(link.attr('href') || '');
        const urlMatch = href.match(/[?&]url=([^&]+)/);
        if (!urlMatch) {
            return; // 广告/推荐/插件位
        }

        let realUrl = '';
        try {
            realUrl = decodeURIComponent(urlMatch[1]);
        } catch {
            return;
        }
        if (!/^https?:\/\//i.test(realUrl)) {
            return;
        }
        // 排除搜狗自身域名：移动端页面的导航/追踪链接也带 url= 参数，会误提取成"结果"
        try {
            if (/(^|\.)sogou\.com$/i.test(new URL(realUrl).hostname)) {
                return;
            }
        } catch {
            return;
        }

        const title = normalizeText(card.find('h3').first().text());
        if (!title) {
            return;
        }

        const description = normalizeText(card.find('.text-layout, .fz-mid, .str_info, .result-summary-exp, p').first().text());
        let source = '';
        try {
            source = new URL(realUrl).hostname;
        } catch {
            source = '';
        }

        results.push({
            title,
            url: realUrl,
            description,
            source,
            engine: 'sogou'
        });
    });

    return results;
}

export function parseSogouSearchResults(html: string): SearchResult[] {
    if (isSogouChallengePage(html)) {
        throw new Error('Sogou returned a verification or anti-bot page');
    }

    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    const resultSelectors = [
        '#main .vrwrap',
        '#main .rb',
        '#main .result',
        '#results .vrwrap',
        '.results .vrwrap',
        '.results .rb'
    ].join(',');

    $(resultSelectors).each((_, element) => {
        const card = $(element);
        const titleLink = card.find('h3 a[href], h2 a[href], .vr-title a[href], .pt a[href]').first();
        const rawUrl = titleLink.attr('href') || '';
        const url = resolveResultUrl(rawUrl);
        const title = normalizeText(titleLink.text());

        if (!title || !url || seenUrls.has(url)) {
            return;
        }

        let description = normalizeText(card.find('.str_info, .ft, .text-layout, .fz-mid, p').first().text());
        // 搜狗结果卡片尾部常附加 "站点名https://..." 形式的 footer（含真实 URL 与日期），
        // 从首个 http(s):// 处截断，避免描述混入跳转噪声。
        const urlStart = description.search(/https?:\/\//);
        if (urlStart > 0) {
            description = description.slice(0, urlStart).trim();
        }
        const source = extractSource(url, card.find('cite, .citeurl, .g, .url').first().text());

        seenUrls.add(url);
        results.push({
            title,
            url,
            description,
            source,
            engine: 'sogou'
        });
    });

    return results;
}

async function searchSogouPage(query: string, page: number): Promise<SearchResult[]> {
    const url = new URL(SOGOU_SEARCH_URL);
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('ie', 'utf8');

    let parsed: SearchResult[];
    try {
        parsed = parseSogouSearchResults(await fetchSogouHtml(url.toString()));
    } catch (error) {
        // 反爬降级：命中验证页时等待 0.5~1 秒重试一次（给服务端一次冷却机会），
        // 仍失败才向上抛（由 searchService 的 partialFailures/级联换引擎接管）
        const message = error instanceof Error ? error.message : String(error);
        if (!/anti-bot|verification/i.test(message)) {
            throw error;
        }
        console.warn('Sogou returned an anti-bot page, retrying once after a short delay');
        // 0.5~1s：重试需重跑多跳 fetch（含 cookie 管理），等待过长会与重试成本叠加
        await sleep(500 + Math.random() * 500);
        try {
            parsed = parseSogouSearchResults(await fetchSogouHtml(url.toString()));
        } catch (retryError) {
            // 引擎内已重试过一次：最终失败标记不可重试，避免 searchService 再叠加 3 次重试
            // （否则 3 × ~4.5s 会吃满 10s 上限报 timeout，而不是快速失败交级联补位）
            const finalError = retryError instanceof Error ? retryError : new Error(String(retryError));
            (finalError as any).retryable = false;
            throw finalError;
        }
    }

    // 跳转链并发解析成真实 URL；source 跟随真实 URL 重新提取。
    // 总预算 3s：预算耗尽后剩余结果保留原跳转链接（仍可用），避免 N+1 请求
    // 把引擎整体耗时推过单引擎超时上限（实测 sogou 8.4s 被掐断）
    const resolved = await mapWithConcurrencyBudget(
        parsed,
        SOGOU_LINK_RESOLVE_CONCURRENCY,
        async (result) => ({
            ...result,
            url: await resolveSogouLinkUrl(result.url),
            source: result.source
        }),
        SOGOU_LINK_RESOLVE_BUDGET_MS,
        (result) => result
    );
    return resolved.map((result) => ({
        ...result,
        source: extractSource(result.url, result.source)
    }));
}

/** PC 端被反爬拦截后的"暂停期"：期间直接走移动端，避免每次白等 PC 端的失败路径 */
const SOGOU_PC_BLOCK_TTL_MS = 10 * 60 * 1000;
let sogouPcBlockedUntil = 0;

/**
 * 双端策略（实测数据驱动）：
 * - 两端共享同一索引，但 **PC 端更全**（同 query 实测 9 条 vs 移动端 6 条，
 *   移动端基本是 PC 端的子集 + 少量独有结果）；
 * - 因此 **PC 端优先**（含分页补全），仅在 PC 被反爬拦截时用**移动端兜底**
 *   （WAP 集群风控宽松，被标记 IP 下通常是唯一可用路径，且明文链接免跳转解析）；
 * - PC 端被拦后记住 10 分钟，期间跳过 PC 端直接走移动端（省掉每次 ~4s 的失败开销）。
 */
export async function searchSogou(query: string, limit: number): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];
    const seenUrls = new Set<string>();

    const merge = (incoming: SearchResult[]): number => {
        let added = 0;
        for (const result of incoming) {
            if (seenUrls.has(result.url)) {
                continue;
            }
            seenUrls.add(result.url);
            allResults.push(result);
            added += 1;
        }
        return added;
    };

    let lastError: unknown;

    // ① PC 端优先（结果更全）
    if (Date.now() >= sogouPcBlockedUntil) {
        const maxPage = Math.max(1, Math.ceil(limit / SOGOU_PAGE_SIZE));
        for (let page = 1; page <= maxPage && allResults.length < limit; page += 1) {
            let pageResults: SearchResult[];
            try {
                pageResults = await searchSogouPage(query, page);
            } catch (error) {
                lastError = error;
                const message = error instanceof Error ? error.message : String(error);
                // 反爬/403 类拦截：进入暂停期，本次转移动端兜底
                if (/anti-bot|verification|challenge|403|访问过于频繁|验证码/i.test(message)) {
                    sogouPcBlockedUntil = Date.now() + SOGOU_PC_BLOCK_TTL_MS;
                }
                console.warn('Sogou PC endpoint failed, falling back to mobile:', message);
                break;
            }

            const added = merge(pageResults);
            if (pageResults.length === 0 || added === 0) {
                break;
            }
        }
    }

    // ② 移动端兜底（PC 被拦时的主要来源；也用于补足 PC 端未达 limit 的部分）
    if (allResults.length < limit) {
        try {
            const mobileResults = await fetchSogouMobileHtml(query).then(parseSogouMobileResults);
            if (mobileResults.length > 0) {
                merge(mobileResults);
                console.error(`✅ Sogou mobile endpoint: ${mobileResults.length} results (fallback)`);
            }
        } catch (error) {
            lastError = lastError ?? error;
            console.warn('Sogou mobile endpoint failed:', error instanceof Error ? error.message : String(error));
        }
    }

    if (allResults.length === 0 && lastError) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    return allResults.slice(0, limit);
}
