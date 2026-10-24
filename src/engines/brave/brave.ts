import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from "../../utils/httpRequest.js";
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { paginateSearch } from '../../utils/pagination.js';
import { assertOverseasEngineUsable } from '../../utils/overseasProbe.js';
import { tripEngineCircuit } from '../../core/search/engineCircuitBreaker.js';
import { isBraveBlockedPage } from '../../core/antiBot/antiBotDetection.js';
import { AppError, extractErrorStatus } from '../../core/errors.js';
export { isBraveBlockedPage };

/**
 * Brave 的 CloudFront WAF 对 HTTP/2 浏览器指纹（wreq/primp）反而更容易返回 429：
 * 实测同一节点、同一时刻，wreq GET → 429，而 axios/curl 的 HTTP/1.1 → 200（连续 6 次）。
 * 因此 Brave 固定走 axios（Node 原生 HTTP/1.1），不要复用 DDG 的 wreq 路径。
 */
const braveHttpGet = (url: string, options: AxiosRequestConfig): Promise<AxiosResponse> =>
    axios.get(url, options);

/** Brave 对数据中心/代理 IP 限流（429）时给出明确提示，而非笼统的 status code 错误 */
function buildBraveErrorMessage(error: unknown): Error {
    const status = extractErrorStatus(error);
    if (status === 429) {
        // 实测 429 来自 AWS CloudFront + WAF 的 IP 级限流（响应带 x-cache: Error from cloudfront）：
        // 被标记的出口 IP 在分钟级窗口内必然持续 429——标记不可重试（避免 3 次重试风暴浪费 5~8 秒）
        // 并熔断该引擎 5 分钟，让配额平移给其他引擎（见 engineCircuitBreaker）
        const err = new AppError({
            code: 'rate_limited',
            retryable: false,
            status: 429,
            engine: 'brave',
            hint: 'Set BRAVE_API_KEY (free tier) to use the official API, or retry after a few minutes / switch exit node.',
            message: 'Brave rate limited (HTTP 429): CloudFront throttled this exit IP — the block is usually minutes-long, not permanent. ' +
                'Bursty requests re-trigger it; a single retry after cooldown can succeed. ' +
                'For a stable path configure BRAVE_API_KEY (official API, free tier) instead of scraping. Retry later, or use startpage/duckduckgo/bing.'
        });
        tripEngineCircuit('brave');
        return err;
    }
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * 解析 Brave 结果页（SvelteKit SSR）。
 * 结果卡结构：
 * .snippet[.svelte-*]（新版外层容器已不带 #results 锚点，选择器必须兼容两种结构）
 *   └── .result-content
 *        ├── > a (main link with href)
 *        │   ├── .site-name-wrapper (source)
 *        │   └── .search-snippet-title (title)
 *        └── .generic-snippet (description)
 */
export function parseBraveResults(html: string, seenUrls: Set<string>, $doc?: cheerio.CheerioAPI): SearchResult[] {
    const $ = $doc ?? cheerio.load(html);
    const results: SearchResult[] = [];

    $('#results .snippet, .snippet').each((_, element) => {
        const resultElement = $(element);
        const content = resultElement.find('.result-content').first();
        if (content.length === 0) return;

        // The first <a> inside .result-content is the main link
        const mainLink = content.find('> a').first();
        const url = mainLink.attr('href');

        // 顶部商业推广卡（服务端注入的 JSON-LD "SearchResultAd"）：实测搜 'vue3' 时第 1 条
        // 是 booking.com 酒店广告，href 为相对跳转 /a/redirect?click_url=...（LLM 无法访问的坏链）。
        // 判据取自实测 DOM：广告卡带 data-type="ad" 且 id="search-ad"，正常结果为 data-type="web"。
        if (resultElement.attr('data-type') === 'ad' || resultElement.attr('id') === 'search-ad') {
            return;
        }
        // 只保留绝对 http(s) 链接：相对跳转（/a/redirect 等广告或站内跳转）对调用方无意义
        if (!url || !/^https?:\/\//i.test(url)) {
            return;
        }

        // Title is inside .search-snippet-title
        const title = mainLink.find('.search-snippet-title').text().trim();

        // Description is in .generic-snippet
        const description = content.find('.generic-snippet').text().trim() || '';

        // Source/site name is in .site-name-wrapper
        const rawSource = mainLink.find('.site-name-wrapper').first().text().trim() || '';

        // 统一 source 为纯域名（面包屑文本如 "cloud.google.com › discover › ..." 跨引擎格式不一致）；
        // URL 解析失败时回退原始面包屑文本
        let source = rawSource;
        if (url) {
            try {
                source = new URL(url).hostname;
            } catch {
                // 保留 rawSource
            }
        }

        // Ensure that we have a valid title and URL before adding
        if (title && url && !seenUrls.has(url)) {
            seenUrls.add(url);
            const ageText = resultElement.find('.snippet-age, .age').first().text().trim();
            let date: string | undefined;
            const m = ageText.match(/(20\d{2}[-年/.]\d{1,2}(?:[-月/.]\d{1,2})?)/)
                || description.match(/(20\d{2}[-年/.]\d{1,2}(?:[-月/.]\d{1,2})?)/);
            if (m && m[1]) {
                date = m[1].replace(/[年/.]/g, '-').replace(/[月日]/g, '');
            }

            results.push({
                title: title,
                url: url,
                description: description,
                source: source,
                engine: 'brave',
                ...(date ? { date } : {})
            });
        }
    });

    return results;
}

export interface BraveApiWebResult {
    title: string;
    url: string;
    description?: string;
    page_age?: string;
    age?: string;
    profile?: {
        name?: string;
        url?: string;
        long_name?: string;
    };
    meta_url?: {
        hostname?: string;
    };
    extra_snippets?: string[];
}

export interface BraveApiResponse {
    web?: {
        results?: BraveApiWebResult[];
    };
}

/** 清洗 Brave 官方 API 返回的文本：去除 HTML 标签、还原常见 HTML 实体、压缩多余空格 */
export function cleanBraveApiText(text: string): string {
    return text
        .replace(/<[^>]*>/g, '')
        .replace(/&[a-zA-Z#0-9]+;/g, (entity) => {
            const named: Record<string, string> = {
                '&amp;': '&',
                '&lt;': '<',
                '&gt;': '>',
                '&quot;': '"',
                '&#39;': "'",
                '&apos;': "'",
                '&#x27;': "'",
                '&nbsp;': ' '
            };
            return named[entity] ?? ' ';
        })
        .replace(/\s+/g, ' ')
        .trim();
}

/** 官方 API 熔断/降级冷却状态管理（避免在密钥错误或配额耗尽时，每次搜索都白白多发起一次必挂的 HTTP 请求） */
let officialApiDisabledUntil = 0;
let officialApiDisableReason = '';

export function isBraveOfficialApiDisabled(): boolean {
    return Date.now() < officialApiDisabledUntil;
}

export function disableBraveOfficialApi(durationMs: number, reason: string): void {
    officialApiDisabledUntil = Date.now() + durationMs;
    officialApiDisableReason = reason;
}

export function resetBraveOfficialApiCooldown(): void {
    officialApiDisabledUntil = 0;
    officialApiDisableReason = '';
}

export function getBraveOfficialApiCooldownRemainingMs(): number {
    return Math.max(0, officialApiDisabledUntil - Date.now());
}

/**
 * 将 Brave 官方 Search API 返回的 JSON 结构映射为项目的标准 SearchResult 数组。
 * 包含 URL 去重、HTML 标签清洗、域名解析提取及发布日期识别。
 */
export function parseBraveOfficialResults(data: BraveApiResponse, seenUrls: Set<string>): SearchResult[] {
    const results: SearchResult[] = [];
    const items = data.web?.results;
    if (!Array.isArray(items)) {
        return results;
    }

    for (const item of items) {
        const url = item.url?.trim();
        if (!url || !/^https?:\/\//i.test(url) || seenUrls.has(url)) {
            continue;
        }
        seenUrls.add(url);

        const title = cleanBraveApiText(item.title || '');
        if (!title) {
            continue;
        }

        let description = cleanBraveApiText(item.description || '');
        if (Array.isArray(item.extra_snippets) && item.extra_snippets.length > 0) {
            const extra = item.extra_snippets.map((s) => cleanBraveApiText(s)).filter(Boolean).join(' ');
            if (extra) {
                description = description ? `${description} ${extra}` : extra;
            }
        }

        let source = item.meta_url?.hostname || item.profile?.name || '';
        if (!source) {
            try {
                source = new URL(url).hostname;
            } catch {
                source = '';
            }
        }

        let date: string | undefined;
        const rawAge = item.page_age || item.age;
        if (rawAge) {
            const m = rawAge.match(/(20\d{2}[-年/.]\d{1,2}(?:[-月/.]\d{1,2})?)/);
            if (m && m[1]) {
                date = m[1].replace(/[年/.]/g, '-').replace(/[月日]/g, '');
            }
        }

        results.push({
            title,
            url,
            description,
            source,
            engine: 'brave',
            ...(date ? { date } : {})
        });
    }

    return results;
}

/**
 * Brave 官方 Web Search API 搜索实现（高可靠免反爬，需 BRAVE_API_KEY）。
 * 官方端点: https://api.search.brave.com/res/v1/web/search
 */
export async function searchBraveOfficial(
    query: string,
    limit: number,
    apiKey: string,
    signal?: AbortSignal,
    timeRange?: 'day' | 'week' | 'month' | 'year'
): Promise<SearchResult[]> {
    const seenUrls = new Set<string>();
    const encodedQuery = encodeURIComponent(query);
    const freshnessMap: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
    const freshness = timeRange ? freshnessMap[timeRange] : undefined;

    return paginateSearch({
        limit,
        signal,
        maxPages: 10,
        fetchPage: async (pageIndex) => {
            // Brave 官方 API 的 offset 参数支持 0 ~ 9（对应前 10 页）
            if (pageIndex > 9) {
                return [];
            }
            const remaining = limit - seenUrls.size;
            if (remaining <= 0) {
                return [];
            }
            const pageSize = Math.min(20, Math.max(1, remaining));
            const requestOptions = buildAxiosRequestOptions({
                engine: 'brave',
                trustedStaticHost: true,
                signal,
                headers: {
                    'Accept': 'application/json',
                    'Accept-Encoding': 'gzip',
                    'X-Subscription-Token': apiKey
                }
            });

            try {
                const response = await axios.get<BraveApiResponse>(
                    `https://api.search.brave.com/res/v1/web/search?q=${encodedQuery}&count=${pageSize}&offset=${pageIndex}&text_decorations=0${freshness ? `&freshness=${freshness}` : ''}`,
                    requestOptions
                );
                return parseBraveOfficialResults(response.data, seenUrls);
            } catch (error: unknown) {
                // 若为多页抓取后续页失败，但首页已拿到结果，优先返回已有结果而不丢弃
                if (pageIndex > 0 && seenUrls.size > 0) {
                    return [];
                }
                const status = extractErrorStatus(error);
                if (status === 401 || status === 403 || status === 422) {
                    throw new AppError({
                        code: 'unauthorized',
                        engine: 'brave',
                        retryable: false,
                        status,
                        message: `Invalid Brave Search API key (HTTP ${status}). Please check your BRAVE_API_KEY configuration.`
                    });
                }
                if (status === 429) {
                    // 注意：这里不要 tripEngineCircuit('brave')，因为官方 API 429（配额用尽/QPS超限）时，
                    // 网页版爬虫 search.brave.com 往往依然可用，交由 searchBrave 优雅降级回退！
                    throw new AppError({
                        code: 'rate_limited',
                        engine: 'brave',
                        retryable: false,
                        status: 429,
                        message: 'Brave Search API rate limit or quota exceeded (HTTP 429).'
                    });
                }
                throw error;
            }
        }
    });
}

/**
 * Brave 网页端（SvelteKit SSR）抓取搜索实现（无 API Key 时的默认路径，或官方 API 故障/密钥错误/配额耗尽时的回退路径）。
 */
export async function searchBraveWeb(
    query: string,
    limit: number,
    options?: { signal?: AbortSignal; timeRange?: 'day' | 'week' | 'month' | 'year' }
): Promise<SearchResult[]> {
    const signal = options?.signal;
    const timeRange = options?.timeRange;
    const freshnessMap: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
    const freshness = timeRange ? freshnessMap[timeRange] : undefined;
    const seenUrls = new Set<string>();
    const encodedQuery = encodeURIComponent(query);
    const requestOptions = buildAxiosRequestOptions({
        engine: 'brave',
        trustedStaticHost: true,
        signal,
        headers: {
            "User-Agent": BROWSER_USER_AGENT,
            "Connection": "keep-alive",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": "\"Chromium\";v=\"133\", \"Google Chrome\";v=\"133\", \"Not:A-Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "upgrade-insecure-requests": "1",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "navigate",
            "sec-fetch-user": "?1",
            "sec-fetch-dest": "document",
            "referer": "https://search.brave.com/",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
    });

    return paginateSearch({
        limit,
        signal,
        fetchPage: async (pageIndex) => {
            let response;
            try {
                response = await braveHttpGet(`https://search.brave.com/search?q=${encodedQuery}&source=web&offset=${pageIndex}${freshness ? `&freshness=${freshness}` : ''}`, requestOptions);
            } catch (error) {
                throw buildBraveErrorMessage(error);
            }

            const html = String(response.data || '');
            const $ = cheerio.load(html);

            // 反爬/拦截页检测：命中时抛明确错误（不再静默返回 0 条伪装成"没有结果"）
            if (isBraveBlockedPage(html, $)) {
                throw new AppError({
                    code: 'bot_challenge',
                    retryable: false,
                    engine: 'brave',
                    message: 'Brave returned a verification or anti-bot page (access denied / captcha)'
                });
            }

            return parseBraveResults(html, seenUrls, $);
        }
    });
}

export async function searchBrave(query: string, limit: number, options?: { signal?: AbortSignal; timeRange?: 'day' | 'week' | 'month' | 'year' }): Promise<SearchResult[]> {
    const signal = options?.signal;
    // 未配置代理时先探测直连可达性：不可达立即报"需要代理"，避免直连挂超时拖累整次搜索
    await assertOverseasEngineUsable('brave');

    const apiKey = (process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY)?.trim();
    if (apiKey) {
        if (!isBraveOfficialApiDisabled()) {
            try {
                return await searchBraveOfficial(query, limit, apiKey, signal, options?.timeRange);
            } catch (error: unknown) {
                // 用户显式取消操作时直接透传其中断信号，不降级重试
                if (signal?.aborted) {
                    throw signal.reason instanceof Error ? signal.reason : new Error('Brave search aborted');
                }
                const status = extractErrorStatus(error);
                const message = error instanceof Error ? error.message : String(error);

                if (status === 401 || status === 403 || status === 422) {
                    // 场景 1: 密钥填错 / 格式非法 / 未授权（冷却 10 分钟）
                    disableBraveOfficialApi(10 * 60 * 1000, `Invalid API Key (HTTP ${status})`);
                    console.warn(`⚠️ [Brave] Official API key invalid or unauthorized (HTTP ${status}), falling back to web scraping (cached 10m): ${message}`);
                } else if (status === 429 || /quota|rate limit/i.test(message)) {
                    // 场景 2: 配额用尽 / 频率限流（冷却 5 分钟）
                    disableBraveOfficialApi(5 * 60 * 1000, 'Quota Exhausted / Rate Limited (HTTP 429)');
                    console.warn(`⚠️ [Brave] Official API quota exhausted or rate limited (HTTP ${status || 429}), falling back to web scraping (cached 5m): ${message}`);
                } else {
                    // 场景 3: 官方服务暂不可用 (5xx/超时/网络异常)（冷却 1 分钟）
                    disableBraveOfficialApi(60 * 1000, `Service Unavailable (HTTP ${status || 'Network'})`);
                    console.warn(`⚠️ [Brave] Official API temporarily unavailable (${status ? `HTTP ${status}: ` : ''}${message}), falling back to web scraping (cached 1m)`);
                }

                // 统一优雅降级到网页端抓取
                return searchBraveWeb(query, limit, options);
            }
        } else {
            // 冷却期内直接走网页端抓取，避免每次搜索白白浪费一次必挂的网络请求
            return searchBraveWeb(query, limit, options);
        }
    }

    return searchBraveWeb(query, limit, options);
}

