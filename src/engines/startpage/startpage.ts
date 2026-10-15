import axios from 'axios';
import * as cheerio from 'cheerio';
import { config, getEngineSearchMode, type AppConfig } from '../../config.js';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { assertOverseasEngineUsable } from '../../utils/overseasProbe.js';
import { warmupWithAnubisPow } from './anubisSolver.js';
import { AppError } from '../../core/errors.js';

const STARTPAGE_BASE_URL = 'https://www.startpage.com';
const STARTPAGE_SEARCH_URL = `${STARTPAGE_BASE_URL}/sp/search`;
const STARTPAGE_SC_TTL_MS = 30 * 60 * 1000;
/** Anubis PoW 会话的 TTL：放行 JWT 有效期 5 分钟，取 4 分钟保守值 */
const ANUBIS_SESSION_TTL_MS = 4 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 10;

import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';
const COMMON_HEADERS = {
    'User-Agent': DEFAULT_DESKTOP_UA,
    'Accept-Language': 'en-US,en;q=0.9'
};

let cachedScCode: string | undefined;
let cachedCookies: string | undefined;
let cachedScAt = 0;
/** 当前缓存的会话 TTL（PoW 会话 4 分钟 / Playwright 会话 30 分钟） */
let currentSessionTtlMs = STARTPAGE_SC_TTL_MS;

export function resetStartpageCache(): void {
    cachedScCode = undefined;
    cachedCookies = undefined;
    cachedScAt = 0;
    inflightScWarmupPromise = null;
}

import { isStartpageCaptchaPage } from '../../core/antiBot/antiBotDetection.js';
const isCaptchaPage = isStartpageCaptchaPage;

function extractScCode(html: string): string | undefined {
    const $ = cheerio.load(html);
    return $('form[action="/sp/search"] input[name="sc"]').first().attr('value')?.trim() || undefined;
}

function extractInterstitialPayload(html: string): Record<string, string> | undefined {
    const match = html.match(/var data = (\{[\s\S]*?\});/);
    const payloadJson = match?.[1];
    if (!payloadJson) {
        return undefined;
    }

    try {
        const payload = JSON.parse(payloadJson) as Record<string, unknown>;
        if (typeof payload?.query !== 'string' || typeof payload?.sgt !== 'string') {
            return undefined;
        }

        const data = Object.entries(payload).reduce<Record<string, string>>((acc, [key, value]) => {
            if (typeof value === 'string') {
                acc[key] = value;
            }
            return acc;
        }, {});

        return Object.keys(data).length > 0 ? data : undefined;
    } catch {
        return undefined;
    }
}

// startpage 自 2025 年起部署 Anubis 反爬（proof-of-work + JS 执行，专防 AI/LLM 爬虫），
// 纯 HTTP 请求无法获取搜索 token（返回 "Verifying your request..." 或 "Startpage Blocked"）。
// 实测 headless 模式会被 startpage 直接屏蔽（返回 captcha-block 页 "Startpage Blocked"），
// 只有 headed/hidden-headed（隐藏有头）模式能完成 Anubis 挑战拿到搜索表单。
// 方案：用 Playwright hidden-headed 模式打开首页完成 Anubis 挑战，
// 提取放行 cookie（spchal-auth 等）+ sc token 并缓存复用；cookie 失效时重新预热。
async function warmupStartpageSession(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Request aborted');
    }
    // SEARCH_MODE 控制：若 startpage 不在 playwright 允许名单中（如 SEARCH_MODE=bing 或 request），
    // 不启动重型浏览器预热，HTTP 被反爬直接报错，配合 minResults 级联自动换其他轻量引擎。
    const startpageMode = getEngineSearchMode('startpage', config);
    if (startpageMode === 'request') {
        const { AppError } = await import('../../core/errors.js');
        throw new AppError({
            code: 'invalid_config',
            retryable: false,
            engine: 'startpage',
            message: 'Startpage requires a Playwright browser session (Anubis anti-bot), but SEARCH_MODE disables Playwright for startpage. Enable startpage in SEARCH_MODE (e.g. SEARCH_MODE=auto or SEARCH_MODE=startpage), or use another engine (e.g. bing/baidu/sogou).'
        });
    }
    let session: import('../../utils/playwright/types.js').PlaywrightBrowserSession | undefined;
    let releasePage: (() => Promise<void>) | undefined;
    let removeAbortListener: (() => void) | undefined;
    try {
        const { openPlaywrightBrowser, acquirePooledPlaywrightPage } = await import('../../utils/playwrightClient.js');
        const { prepareStealthPage } = await import('../../utils/browserStealth.js');

        // 复用项目统一的 Playwright 基础设施（openPlaywrightBrowser + 页面池 + stealth 反检测），
        // 自动处理：浏览器路径/WS/CDP 端点、按引擎代理、指纹伪装。
        // 注意：playwright 1.62+ 已移除 page.setUserAgent，需通过 contextOptions.userAgent 设置。
        // startpage 会屏蔽 headless 浏览器，必须用 hidden-headed（隐藏有头）模式打开。
        session = await openPlaywrightBrowser(false, [], { hideWindow: true });
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new AppError({ code: 'aborted', engine: 'startpage', message: 'Request aborted', retryable: false });
        }
        const pooled = await acquirePooledPlaywrightPage(session.browser, {
            poolKey: 'startpage-warmup',
            contextOptions: {
                userAgent: COMMON_HEADERS['User-Agent'],
                locale: 'en-US',
                viewport: { width: 1920, height: 1080 }
            },
            preparePage: prepareStealthPage
        });
        releasePage = pooled.releasePage;
        const page = pooled.page;
        if (signal) {
            const onAbort = () => {
                if (releasePage) {
                    const release = releasePage;
                    releasePage = undefined;
                    void release().catch(() => undefined);
                }
            };
            signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        }
        await page.goto(`${STARTPAGE_BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // 等待 Anubis PoW 完成：搜索表单出现即放行
        await page.waitForSelector('form[action="/sp/search"]', { timeout: 30000 });
        const scCode = await page.locator('form[action="/sp/search"] input[name="sc"]').first()
            .getAttribute('value')
            .catch(() => null);
        if (!scCode) {
            throw new AppError({
                code: 'engine_parse_error',
                retryable: true,
                engine: 'startpage',
                message: 'Failed to extract Startpage search token after Anubis challenge'
            });
        }
        const cookies = await page.context().cookies(STARTPAGE_BASE_URL);
        const cookieStr = cookies.map((cookie: { name: string; value: string }) => `${cookie.name}=${cookie.value}`).join('; ');
        if (!cookieStr) {
            throw new AppError({
                code: 'engine_parse_error',
                retryable: true,
                engine: 'startpage',
                message: 'Failed to extract Startpage session cookies after Anubis challenge'
            });
        }
        cachedScCode = scCode;
        cachedCookies = cookieStr;
        cachedScAt = Date.now();
    } finally {
        removeAbortListener?.();
        if (releasePage) {
            await releasePage().catch(() => undefined);
        }
        if (session) {
            await session.release().catch(() => undefined);
        }
    }
}

let inflightScWarmupPromise: Promise<string> | null = null;

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', engine: 'startpage', message: 'Request aborted', retryable: false });
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(signal.reason instanceof Error
                ? signal.reason
                : new AppError({ code: 'aborted', engine: 'startpage', message: 'Request aborted', retryable: false }));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (val) => {
                signal.removeEventListener('abort', onAbort);
                resolve(val);
            },
            (err) => {
                signal.removeEventListener('abort', onAbort);
                reject(err);
            }
        );
    });
}

async function getScCode(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', engine: 'startpage', message: 'Request aborted', retryable: false });
    }
    const now = Date.now();
    if (cachedScCode && now - cachedScAt < currentSessionTtlMs) {
        return cachedScCode;
    }

    if (inflightScWarmupPromise) {
        return awaitWithSignal(inflightScWarmupPromise, signal);
    }

    inflightScWarmupPromise = (async () => {
        const warmupController = new AbortController();
        const warmupTimer = setTimeout(() => warmupController.abort(), 35000);
        try {
            // ① 纯 HTTP Anubis PoW 求解（Worker 异步无阻塞；difficulty<=5 时全流程约 2.6s）
            try {
                const session = await warmupWithAnubisPow(warmupController.signal);
                if (session) {
                    cachedScCode = session.scCode;
                    cachedCookies = session.cookies;
                    cachedScAt = Date.now();
                    currentSessionTtlMs = ANUBIS_SESSION_TTL_MS;
                    console.error('✅ Startpage warmup via Anubis PoW (no browser needed)');
                    return cachedScCode;
                }
                console.warn('Startpage Anubis PoW warmup returned no session, falling back to Playwright');
            } catch (error) {
                if (warmupController.signal.aborted) {
                    throw error;
                }
                console.warn('Startpage Anubis PoW warmup failed, falling back to Playwright:', error instanceof Error ? error.message : String(error));
            }

            // ② Playwright 兜底（hidden-headed 模式，见 warmupStartpageSession）
            await warmupStartpageSession(warmupController.signal);
            if (!cachedScCode) {
                throw new AppError({
                    code: 'engine_parse_error',
                    retryable: true,
                    engine: 'startpage',
                    message: 'Failed to extract Startpage search token'
                });
            }
            currentSessionTtlMs = STARTPAGE_SC_TTL_MS;
            return cachedScCode;
        } finally {
            clearTimeout(warmupTimer);
        }
    })().finally(() => {
        inflightScWarmupPromise = null;
    });

    return awaitWithSignal(inflightScWarmupPromise, signal);
}

export function extractResultsFromHtml(html: string): SearchResult[] {
    const $ = cheerio.load(html);
    if (isCaptchaPage(html, $)) {
        cachedScCode = undefined;
        cachedCookies = undefined;
        cachedScAt = 0;
        throw new AppError({
            code: 'bot_challenge',
            retryable: false,
            engine: 'startpage',
            message: 'Startpage returned a verification or anti-bot page'
        });
    }

    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    $('a.result-title.result-link[href]').each((_, element) => {
        const link = $(element);
        const url = link.attr('href')?.trim();
        const title = link.find('h2').first().text().replace(/\s+/g, ' ').trim();
        const description = link.nextAll('p.description').first().text().replace(/\s+/g, ' ').trim();

        if (!url || !title || seenUrls.has(url)) {
            return;
        }
        seenUrls.add(url);

        let source = '';
        try {
            source = new URL(url).hostname;
        } catch {
            source = '';
        }

        results.push({
            title,
            url,
            description,
            source,
            engine: 'startpage'
        });
    });

    return results;
}

async function searchStartpagePage(query: string, page: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const scCode = await getScCode(signal);
    const formData = new URLSearchParams({
        query,
        cat: 'web',
        t: 'device',
        sc: scCode,
        abp: '1',
        abd: '1',
        abe: '1'
    });

    if (page > 1) {
        formData.set('page', String(page));
        formData.set('segment', 'startpage.udog');
    }

    const response = await axios.post(
        STARTPAGE_SEARCH_URL,
        formData.toString(),
        buildAxiosRequestOptions({ engine: 'startpage',
            trustedStaticHost: true,
            signal,
            headers: {
                ...COMMON_HEADERS,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': STARTPAGE_BASE_URL,
                'Referer': `${STARTPAGE_BASE_URL}/`,
                ...(cachedCookies ? { 'Cookie': cachedCookies } : {})
            },
            timeout: 20000
        })
    );

    let html = String(response.data || '');
    const interstitialPayload = extractInterstitialPayload(html);
    if (interstitialPayload) {
        const followUpResponse = await axios.post(
            STARTPAGE_SEARCH_URL,
            new URLSearchParams(interstitialPayload).toString(),
            buildAxiosRequestOptions({ engine: 'startpage',
                trustedStaticHost: true,
                signal,
                headers: {
                    ...COMMON_HEADERS,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': STARTPAGE_BASE_URL,
                    'Referer': STARTPAGE_SEARCH_URL,
                    ...(cachedCookies ? { 'Cookie': cachedCookies } : {})
                },
                timeout: 20000
            })
        );

        html = String(followUpResponse.data || '');
    }

    return extractResultsFromHtml(html);
}

import { paginateSearch } from '../../utils/pagination.js';

export async function searchStartpage(
    query: string,
    limit: number,
    options?: { searchMode?: AppConfig['searchMode']; signal?: AbortSignal }
): Promise<SearchResult[]> {
    const signal = options?.signal;
    // 未配置代理时先探测直连可达性：不可达立即报"需要代理"，避免直连挂超时拖累整次搜索
    await assertOverseasEngineUsable('startpage');

    return paginateSearch({
        limit,
        initialPage: 1,
        pageStep: 1,
        signal,
        fetchPage: (page) => searchStartpagePage(query, page, signal),
        dedupKey: (result) => result.url
    });
}
