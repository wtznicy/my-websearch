import axios, { type AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { AppConfig, config, getEngineSearchMode } from '../../config.js';
import { EngineSearchResponse, SearchResult } from '../../types.js';
import { parseBingSearchResults } from './parser.js';
import { prepareStealthPage } from '../../utils/browserStealth.js';
import { isBingImpersonateCircuitOpen, isImpersonateAvailable, searchBingWithImpersonate } from './impersonate.js';
import {
    acquirePooledPlaywrightPage,
    getPlaywrightModuleSource,
    loadPlaywrightClient,
    openPlaywrightBrowser,
    PlaywrightLocatorLike,
    PlaywrightPageLike
} from '../../utils/playwrightClient.js';
import { buildAxiosRequestOptions as buildSharedAxiosRequestOptions } from '../../utils/httpRequest.js';
import { AppError, isAbortedError, isCascadeAbortedError } from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';
import { hasFirstTokenDrift } from '../../core/search/resultRanking.js';

// 默认面向大陆部署用 cn.bing.com；可通过 BING_BASE_URL（兼容 OPEN_WEBSEARCH_BING_HOST）覆盖为 www.bing.com 等获取国际区结果
export function getBingHomeUrl(): string {
    try {
        const url = new URL(config.bingBaseUrl || 'https://cn.bing.com/search');
        return `${url.origin}/?mkt=zh-CN`;
    } catch {
        return 'https://www.bing.com/?mkt=zh-CN';
    }
}
import { DEFAULT_DESKTOP_UA, DESKTOP_UA_POOL } from '../../utils/userAgents.js';
const BROWSER_USER_AGENT = DEFAULT_DESKTOP_UA;
const SEARCH_INPUT_SELECTORS = [
    'input[name="q"]',
    'input[type="search"]',
    '#sb_form_q',
    'input#sb_form_q',
    '.b_searchboxForm input'
];
const NEXT_PAGE_SELECTORS = [
    'a.sb_pagN',
    '.b_pag a.sb_pagN',
    'a[title="Next page"]',
    'a[aria-label="Next page"]'
];
const SEARCH_SUBMIT_SELECTORS = [
    '#sb_form_go',
    'button[type="submit"]',
    'input[type="submit"]',
    'button[aria-label="搜索"]',
    'button[aria-label="Search"]'
];
// 更接近真实浏览器的请求头集合（EnhancedBing 同款反爬对抗）：
// 随机 UA/语言、全套 Sec-Fetch 头、随机 MUID cookie，降低被 Bing 反爬拦截的概率。
const BROWSER_USER_AGENTS = DESKTOP_UA_POOL;
const ACCEPT_LANGUAGES = [
    'zh-CN,zh;q=0.9,en;q=0.8',
    'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'zh-CN,zh-Hans;q=0.9,en;q=0.8',
    'zh-CN,zh;q=0.8,en-US;q=0.7,en;q=0.6'
];
const SEC_CH_UA_VARIANTS = [
    '"Not_A Brand";v="8", "Chromium";v="133", "Google Chrome";v="133"',
    '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
    '"Not_A Brand";v="99", "Chromium";v="132", "Google Chrome";v="132"'
];

function pickRandom<T>(items: readonly T[]): T {
    const item = items[Math.floor(Math.random() * items.length)];
    if (item === undefined) {
        throw new Error('Cannot pick from an empty array');
    }
    return item;
}

function generateMuid(): string {
    // 与浏览器生成的 MUID 格式相近的随机值
    return `${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;
}

function buildBingAntiDetectionHeaders(): Record<string, string> {
    const userAgent = pickRandom(BROWSER_USER_AGENTS);
    const acceptLanguage = pickRandom(ACCEPT_LANGUAGES);
    const secChUa = pickRandom(SEC_CH_UA_VARIANTS);

    return {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Sec-Ch-Ua': secChUa,
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'DNT': '1',
        // 随机 MUID cookie，模拟浏览器首次访问 Bing 的状态
        'Cookie': `SRCHHPGUSR=SRCHLANG=zh-Hans; _EDGE_S=ui=zh-cn; _EDGE_V=1; MUID=${generateMuid()}`
    };
}

const BOT_DETECTION_KEYWORDS = [
    'captcha',
    'verification',
    'verify you are human',
    'access denied',
    'blocked',
    'rate limit',
    'too many requests',
    '请验证',
    '验证码',
    '人机验证'
];
const BROWSER_CONTEXT_OPTIONS = {
    userAgent: BROWSER_USER_AGENT,
    locale: 'zh-CN',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: 'light'
};

export function hasSiteOperator(query: string): boolean {
    return /(^|\s)site:[^\s]+/i.test(query);
}

/**
 * 提取查询中所有 `site:domain` 限定的规范化域名（小写、剥离协议/路径/端口/前导 www.）。
 */
export function extractSiteDomains(query: string): string[] {
    const domains: string[] = [];
    for (const match of query.matchAll(/(?:^|\s)site:([^\s]+)/gi)) {
        const raw = (match[1] ?? '').trim()
            .replace(/^["']+|["',;.)\]]+$/g, '')
            .replace(/^https?:\/\//i, '');
        const hostPart = (raw.split('/')[0] ?? '').split(':')[0]?.toLowerCase().replace(/^\.+|^www\./, '') ?? '';
        if (hostPart && hostPart.includes('.') && !domains.includes(hostPart)) {
            domains.push(hostPart);
        }
    }
    return domains;
}

/**
 * 校验结果 URL 是否满足 `site:` 域名限定（精确匹配该域名或其子域名）。
 */
export function matchesSiteDomains(url: string, siteDomains: string[]): boolean {
    if (siteDomains.length === 0) {
        return true;
    }
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        return siteDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch {
        return false;
    }
}

export function shouldSuggestRemovingSiteOperator(query: string, error: unknown): boolean {
    if (!hasSiteOperator(query) || !(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('waitforselector') || message.includes('timeout');
}

export function buildBingSearchUrl(query: string, pageNumber: number, timeRange?: 'day' | 'week' | 'month' | 'year'): string {
    const baseUrl = config.bingBaseUrl;
    const url = new URL(baseUrl);
    url.searchParams.set('q', query);
    // 仅在 cn.bing.com（面向大陆默认）时强制 zh-CN 区域；自定义 host（如 www.bing.com）让 Bing 按访问者自动定位
    if (baseUrl.includes('cn.bing.com')) {
        url.searchParams.set('setlang', 'zh-CN');
        url.searchParams.set('ensearch', '0');
    }
    url.searchParams.set('first', String(1 + pageNumber * 10));
    if (timeRange) {
        const bingFilterMap: Record<string, string> = {
            day: 'ex1:"ez1"',
            week: 'ex1:"ez2"',
            month: 'ex1:"ez3"',
            year: 'ex1:"ez5"'
        };
        const filterVal = bingFilterMap[timeRange];
        if (filterVal) {
            url.searchParams.set('filters', filterVal);
        }
    }
    return url.toString();
}

import { analyzeBingBlockedPage } from '../../core/antiBot/antiBotDetection.js';

/**
 * 判断 Bing 页面是否被反爬拦截。复用调用方已 load 的 cheerio 文档实例，
 * 避免与正式提取重复解析同一页 HTML（原实现每页 load 3 次）。
 */
function analyzeBlockedPage($: cheerio.CheerioAPI, html: string): ReturnType<typeof analyzeBingBlockedPage> {
    return analyzeBingBlockedPage($, html);
}

function buildBingAxiosRequestOptions(signal?: AbortSignal): AxiosRequestConfig {
    return buildSharedAxiosRequestOptions({ engine: 'bing',
        trustedStaticHost: true,
        headers: buildBingAntiDetectionHeaders(),
        timeout: config.playwrightNavigationTimeoutMs,
        signal
    });
}

let playwrightAvailabilityPromise: Promise<boolean> | null = null;
let hasVerifiedPlaywrightAvailability = false;
let hasLoggedHiddenHeadedMode = false;

function shouldUseHiddenHeadedBingBrowser(): boolean {
    return process.platform === 'win32'
        && config.playwrightHeadless
        && !config.playwrightCdpEndpoint;
}

function getEffectiveBingPlaywrightHeadless(): boolean {
    if (shouldUseHiddenHeadedBingBrowser()) {
        if (!hasLoggedHiddenHeadedMode) {
            hasLoggedHiddenHeadedMode = true;
            console.warn('Bing Playwright search is using a hidden headed browser on Windows because PLAYWRIGHT_HEADLESS=true is more likely to trigger anti-bot detection.');
        }
        return false;
    }

    return config.playwrightHeadless;
}

function buildDefaultBrowserLaunchArgs(hideWindow: boolean): string[] {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection'
    ];

    if (hideWindow) {
        args.push('--disable-extensions');
        args.push('--no-default-browser-check');
        args.push('--window-position=-32000,-32000');
        args.push('--window-size=1,1');
    }

    return args;
}

function buildWindowsBrowserLaunchArgs(hideWindow: boolean): string[] {
    // 修复 Windows/Edge 有头浏览器连续提示“不受支持的命令行标志”的问题：Windows 路径使用 allowlist，避免把 Linux/root 或跨站安全绕过类参数带到用户可见浏览器窗口里。
    const args = [
        '--no-first-run'
    ];

    if (hideWindow) {
        args.push('--no-default-browser-check');
        args.push('--window-position=-32000,-32000');
        args.push('--window-size=1,1');
    }

    return args;
}

function buildBrowserLaunchArgs(hideWindow: boolean, platform: NodeJS.Platform = process.platform): string[] {
    return platform === 'win32'
        ? buildWindowsBrowserLaunchArgs(hideWindow)
        : buildDefaultBrowserLaunchArgs(hideWindow);
}

export function __buildBingBrowserLaunchArgsForTests(hideWindow: boolean, platform?: NodeJS.Platform): string[] {
    return buildBrowserLaunchArgs(hideWindow, platform);
}

export function __analyzeBlockedPageForTests($: cheerio.CheerioAPI, html: string): ReturnType<typeof analyzeBingBlockedPage> {
    return analyzeBlockedPage($, html);
}

function getBingUiTimeoutMs(): number {
    return Math.min(config.playwrightNavigationTimeoutMs, 15000);
}

async function waitForBingResultsReady(page: PlaywrightPageLike): Promise<void> {
    await page.waitForSelector('#b_results, .b_algo, #b_content', {
        timeout: getBingUiTimeoutMs()
    });
}

async function getBingResultsSignature(page: PlaywrightPageLike): Promise<string> {
    return page.evaluate<string>(() => {
        const container = document.querySelector('#b_results') || document.querySelector('#b_content');
        return (container?.textContent || '').replace(/\s+/g, ' ').trim();
    }).catch(() => '');
}

async function waitForBingResultsChanged(page: PlaywrightPageLike, previousSignature: string): Promise<void> {
    await page.waitForFunction((previous: string) => {
        const container = document.querySelector('#b_results') || document.querySelector('#b_content');
        const current = (container?.textContent || '').replace(/\s+/g, ' ').trim();
        return current.length > 0 && current !== previous;
    }, previousSignature, { timeout: getBingUiTimeoutMs() });
}

async function waitForBingSearchInputValue(page: PlaywrightPageLike, expectedValue: string): Promise<void> {
    await page.waitForFunction(({ selectors, value }: { selectors: string[]; value: string }) => {
        const isVisible = (element: Element) => {
            const style = window.getComputedStyle(element);
            return style.visibility !== 'hidden'
                && style.display !== 'none'
                && element.getClientRects().length > 0;
        };

        return selectors.some((selector) => {
            const input = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
            return input !== null && isVisible(input) && input.value === value;
        });
    }, { selectors: SEARCH_INPUT_SELECTORS, value: expectedValue }, { timeout: getBingUiTimeoutMs() });
}

async function waitForAnyDeterministicSignal(signals: Array<Promise<unknown>>, timeoutMs: number): Promise<boolean> {
    if (signals.length === 0) {
        return false;
    }

    return new Promise((resolve) => {
        let settled = false;
        let rejected = 0;
        let timer: NodeJS.Timeout | null = null;
        const finish = (value: boolean) => {
            if (settled) {
                return;
            }

            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            resolve(value);
        };

        timer = setTimeout(() => finish(false), timeoutMs);
        for (const signal of signals) {
            signal.then(() => finish(true)).catch(() => {
                rejected += 1;
                if (rejected >= signals.length) {
                    finish(false);
                }
            });
        }
    });
}

function normalizeBingQueryForUrl(query: string): string {
    return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function doesBingUrlMatchQuery(url: string, query: string): boolean {
    try {
        const parsedUrl = new URL(url);
        if (!isBingUrl(url) || !parsedUrl.pathname.toLowerCase().startsWith('/search')) {
            return false;
        }

        const urlQuery = parsedUrl.searchParams.get('q');
        if (!urlQuery) {
            return false;
        }

        return normalizeBingQueryForUrl(urlQuery) === normalizeBingQueryForUrl(query);
    } catch {
        return false;
    }
}

async function waitForBingQueryNavigation(page: PlaywrightPageLike, previousUrl: string, query: string): Promise<boolean> {
    return page.waitForURL((url: URL) => {
        const nextUrl = url.toString();
        return nextUrl !== previousUrl && doesBingUrlMatchQuery(nextUrl, query);
    }, {
        timeout: getBingUiTimeoutMs(),
        waitUntil: 'domcontentloaded'
    }).then(() => true).catch(() => false);
}

async function waitForBingNextPageNavigation(page: PlaywrightPageLike, previousUrl: string): Promise<void> {
    await page.waitForURL((url: URL) => {
        const nextUrl = url.toString();
        return nextUrl !== previousUrl
            && isBingUrl(nextUrl)
            && url.pathname.toLowerCase().startsWith('/search');
    }, {
        timeout: getBingUiTimeoutMs(),
        waitUntil: 'domcontentloaded'
    });
}

async function submitBingSearchFromCurrentPage(page: PlaywrightPageLike, searchInput: PlaywrightLocatorLike, previousUrl: string, query: string): Promise<void> {
    if (doesBingUrlMatchQuery(page.url(), query)) {
        return;
    }

    const enterNavigation = waitForBingQueryNavigation(page, previousUrl, query);
    await searchInput.press('Enter').catch(() => page.keyboard.press('Enter').catch(() => undefined));
    if (await enterNavigation) {
        return;
    }

    for (const selector of SEARCH_SUBMIT_SELECTORS) {
        const submitButton = page.locator(selector).first();
        if (!await submitButton.isVisible().catch(() => false)) {
            continue;
        }

        const clickNavigation = waitForBingQueryNavigation(page, previousUrl, query);
        await submitButton.click({ timeout: 5000 }).catch(() => undefined);
        if (await clickNavigation) {
            return;
        }
    }

    if (doesBingUrlMatchQuery(page.url(), query)) {
        return;
    }

    throw new AppError({
        code: 'engine_parse_error',
        retryable: true,
        engine: 'bing',
        message: `Bing search submission did not navigate to the expected query URL: ${query}`
    });
}

async function findBingSearchInput(page: PlaywrightPageLike): Promise<PlaywrightLocatorLike | null> {
    for (const selector of SEARCH_INPUT_SELECTORS) {
        const candidate = page.locator(selector).first();
        const isVisible = await candidate.isVisible().catch(() => false);
        if (isVisible) {
            return candidate;
        }
    }

    return null;
}

async function waitForBingSearchInput(page: PlaywrightPageLike): Promise<PlaywrightLocatorLike | null> {
    await page.waitForSelector(SEARCH_INPUT_SELECTORS.join(', '), {
        state: 'visible',
        timeout: getBingUiTimeoutMs()
    }).catch(() => undefined);

    return findBingSearchInput(page);
}

function isBingUrl(url: string): boolean {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return hostname === 'bing.com' || hostname.endsWith('.bing.com');
    } catch {
        return false;
    }
}

async function openBingAndSearch(page: PlaywrightPageLike, query: string): Promise<void> {
    const canReuseCurrentBingPage = isBingUrl(page.url());
    let searchInput = canReuseCurrentBingPage ? await findBingSearchInput(page) : null;
    const previousUrl = page.url();

    // 只有当前页本身就是 Bing 时才复用它的搜索框；否则先回到 Bing 首页，避免把查询输进站内弹窗或第三方页面控件。
    // 对已经停留在 Bing 结果页的情况，仍然优先复用当前页搜索框，避免每次都重新打开首页。
    if (!searchInput) {
        // 修复 hidden-headed 冷启动并发搜索时，Bing 首页少量子资源迟迟不触发 load，导致可用搜索框已经出现但 page.goto 仍超时的问题。
        // 搜索流程只依赖 DOM 和搜索框，改为 domcontentloaded 后再显式等待搜索框，避免把资源加载慢误判为搜索失败。
        await page.goto(getBingHomeUrl(), {
            waitUntil: 'domcontentloaded',
            timeout: Math.max(config.playwrightNavigationTimeoutMs, 30000)
        });
        searchInput = await waitForBingSearchInput(page);
    }

    if (!searchInput) {
        throw new AppError({
            code: 'engine_parse_error',
            retryable: true,
            engine: 'bing',
            message: 'Could not find Bing search input box'
        });
    }


    await searchInput.click({ timeout: getBingUiTimeoutMs() });
    if (typeof searchInput.fill === 'function') {
        await searchInput.fill(query, { timeout: getBingUiTimeoutMs() });
    } else {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => undefined);
        await page.keyboard.press('Backspace').catch(() => undefined);
        await page.keyboard.type(query);
    }
    await waitForBingSearchInputValue(page, query);

    // 解决复用 Bing 结果页搜索框时，旧结果页上的提交动作没有稳定触发新查询的问题。
    // 这里坚持留在当前 Bing 结果页，用同一个搜索框发起下一次查询；只有当 q 参数真正切到新查询后，
    // 才允许进入结果解析。
    await submitBingSearchFromCurrentPage(page, searchInput, previousUrl, query);
    await waitForBingResultsReady(page);
}

async function goToNextResultsPage(page: PlaywrightPageLike): Promise<boolean> {
    for (const selector of NEXT_PAGE_SELECTORS) {
        const nextButton = page.locator(selector).first();
        if (!await nextButton.isVisible().catch(() => false)) {
            continue;
        }

        const previousUrl = page.url();
        const previousSignature = await getBingResultsSignature(page);
        const navigationSignal = waitForBingNextPageNavigation(page, previousUrl);
        const resultsChangedSignal = waitForBingResultsChanged(page, previousSignature);
        void navigationSignal.catch(() => undefined);
        void resultsChangedSignal.catch(() => undefined);

        const clicked = await nextButton.click({ timeout: getBingUiTimeoutMs() })
            .then(() => true)
            .catch(() => false);
        if (!clicked) {
            continue;
        }

        const moved = await waitForAnyDeterministicSignal([
            navigationSignal,
            resultsChangedSignal
        ], getBingUiTimeoutMs());
        if (!moved) {
            continue;
        }

        await waitForBingResultsReady(page);
        return true;
    }

    return false;
}

async function isPlaywrightAvailable(): Promise<boolean> {
    if (hasVerifiedPlaywrightAvailability) {
        return true;
    }

    if (!playwrightAvailabilityPromise) {
        playwrightAvailabilityPromise = (async () => {
            const playwright = await loadPlaywrightClient({ silent: true });
            if (!playwright) {
                return false;
            }

            try {
                const effectiveHeadless = getEffectiveBingPlaywrightHeadless();
                const session = await openPlaywrightBrowser(
                    effectiveHeadless,
                    buildBrowserLaunchArgs(shouldUseHiddenHeadedBingBrowser()),
                    { hideWindow: shouldUseHiddenHeadedBingBrowser() }
                );
                await session.release();
                hasVerifiedPlaywrightAvailability = true;
                return true;
            } catch (error) {
                const playwrightModuleSource = getPlaywrightModuleSource();
                console.warn(`Playwright browser is unavailable${playwrightModuleSource ? ` via ${playwrightModuleSource}` : ''}, auto fallback will retry on the next blocked request:`, error);
                return false;
            }
        })().finally(() => {
            if (!hasVerifiedPlaywrightAvailability) {
                playwrightAvailabilityPromise = null;
            }
        });
    }

    return playwrightAvailabilityPromise;
}

function applySiteDomainFilter(results: EngineSearchResponse, query: string): EngineSearchResponse {
    const siteDomains = extractSiteDomains(query);
    if (siteDomains.length === 0 || results.length === 0) {
        return results;
    }
    const filtered = results.filter((result) => matchesSiteDomains(result.url, siteDomains)) as EngineSearchResponse;
    if (results.directAnswer) {
        filtered.directAnswer = results.directAnswer;
    }
    if (filtered.length === 0) {
        throw new AppError({
            code: 'engine_parse_error',
            retryable: false,
            engine: 'bing',
            hint: 'Bing HTTP ignored the site: operator; falling back to Playwright or cascade engines.',
            message: `Bing HTTP results did not match site:${siteDomains.join(',')} (site: operator ignored by cn.bing HTTP)`
        });
    }
    return filtered;
}

async function searchBingWithHttp(query: string, limit: number, signal?: AbortSignal, timeRange?: 'day' | 'week' | 'month' | 'year'): Promise<SearchResult[]> {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', engine: 'bing', message: 'Bing HTTP search aborted', retryable: false });
    }
    // 首选 wreq-js 指纹请求（Chrome TLS/HTTP2 指纹模拟，规避纯 HTTP 请求被软降级为
    // 无关结果）；原生模块不可用、连续 0 条已熔断、或请求失败时回退到 axios 路径。
    let impersonateResults: EngineSearchResponse | undefined;
    if (!isBingImpersonateCircuitOpen() && await isImpersonateAvailable()) {
        try {
            impersonateResults = await searchBingWithImpersonate(query, limit, signal, timeRange);
        } catch (error) {
            if (signal?.aborted || isAbortedError(error)) {
                if (isCascadeAbortedError(error)) {
                    metrics.debug('bing.impersonate.cascade_aborted', { engine: 'bing' });
                }
                throw error;
            }
            console.warn('Bing impersonate request failed, falling back to axios:', error instanceof Error ? error.message : String(error));
        }
    }
    if (impersonateResults) {
        return applySiteDomainFilter(impersonateResults, query);
    }

    let allResults: SearchResult[] = [];
    let directAnswer: string | undefined;
    let pageNumber = 0;

    while (allResults.length < limit) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new AppError({ code: 'aborted', engine: 'bing', message: 'Bing HTTP search aborted', retryable: false });
        }
        let response: import('axios').AxiosResponse;
        try {
            response = await axios.get(buildBingSearchUrl(query, pageNumber, timeRange), buildBingAxiosRequestOptions(signal));
        } catch (pageError) {
            if (pageNumber > 0 && allResults.length > 0) {
                console.warn(`Bing pagination page ${pageNumber} failed, gracefully returning ${allResults.length} partial results:`, pageError instanceof Error ? pageError.message : String(pageError));
                break;
            }
            throw pageError;
        }
        const html = String(response.data || '');
        // 每页只 cheerio.load 一次，analyzeBlockedPage 与正式提取共用同一文档实例
        const $ = cheerio.load(html);

        const pageState = analyzeBlockedPage($, html);
        if (pageState.blocked) {
            throw new AppError({
                code: 'bot_challenge',
                retryable: false,
                engine: 'bing',
                message: `Bing returned a verification or anti-bot page (title: ${pageState.title || 'unknown'}, keywords: ${pageState.detectedKeywords.join(', ') || 'none'})`
            });
        }
        if (pageState.hasResults && pageState.detectedKeywords.length > 0) {
            console.warn(`Bing page contains suspicious keywords but also has results, skipping block detection: ${pageState.detectedKeywords.join(', ')}`);
        }

        const results = parseBingSearchResults(html, limit - allResults.length, $);
        if (!directAnswer && results.directAnswer) {
            directAnswer = results.directAnswer;
        }
        allResults = allResults.concat(results);

        if (results.length === 0) {
            if (pageNumber === 0 && allResults.length === 0) {
                if (pageState.isNoResults) {
                    break;
                }
                throw new AppError({
                    code: 'bot_challenge',
                    retryable: false,
                    engine: 'bing',
                    message: 'Bing HTTP mode returned 0 results (possible anti-bot layout change or verification)'
                });
            }
            console.error('⚠️ No more Bing results from HTTP mode, ending early.');
            break;
        }

        pageNumber += 1;
    }

    const httpResults = allResults.slice(0, limit) as EngineSearchResponse;
    if (directAnswer) {
        httpResults.directAnswer = directAnswer;
    }
    return applySiteDomainFilter(httpResults, query);
}

async function searchBingWithPlaywright(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', engine: 'bing', message: 'Bing Playwright search aborted', retryable: false });
    }
    const playwright = await loadPlaywrightClient();
    if (!playwright) {
        throw new AppError({
            code: 'invalid_config',
            retryable: false,
            engine: 'bing',
            message: 'Playwright client is not available. Install `playwright`/`playwright-core` manually or configure PLAYWRIGHT_MODULE_PATH.'
        });
    }

    const effectiveHeadless = getEffectiveBingPlaywrightHeadless();
    const session = await openPlaywrightBrowser(
        effectiveHeadless,
        buildBrowserLaunchArgs(shouldUseHiddenHeadedBingBrowser()),
        { hideWindow: shouldUseHiddenHeadedBingBrowser() }
    );

    try {
        const { page, releasePage } = await acquirePooledPlaywrightPage(session.browser, {
            poolKey: 'bing-search',
            contextOptions: BROWSER_CONTEXT_OPTIONS,
            preparePage: prepareStealthPage,
            // 对 Bing 的真实交互流程，这里改成 false 后会稳定复现搜索页等待超时与查询被建议词改写的问题，
            // 说明当前实现仍需要复用 connectOverCDP 暴露出来的现有 context 来保持搜索链路稳定。
            preferExistingContext: true
        });
        let pageReleased = false;
        const safeReleasePage = async () => {
            if (pageReleased) {
                return;
            }
            pageReleased = true;
            await releasePage().catch(() => undefined);
        };
        const onAbort = () => {
            void safeReleasePage();
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
            const allResults: SearchResult[] = [];
            const seenUrls = new Set<string>();
            let directAnswer: string | undefined;

            for (let pageNumber = 0; allResults.length < limit; pageNumber += 1) {
                if (signal?.aborted) {
                    throw signal.reason instanceof Error
                        ? signal.reason
                        : new AppError({ code: 'aborted', engine: 'bing', message: 'Bing Playwright search aborted', retryable: false });
                }
                if (pageNumber === 0) {
                    console.error(`🔎 Bing Playwright interactive search: ${query}`);
                    await openBingAndSearch(page, query);
                } else {
                    const moved = await goToNextResultsPage(page);
                    if (!moved) {
                        console.error('⚠️ No next page button found in Playwright mode, ending early.');
                        break;
                    }
                }

                if (signal?.aborted) {
                    throw signal.reason instanceof Error
                        ? signal.reason
                        : new AppError({ code: 'aborted', engine: 'bing', message: 'Bing Playwright search aborted', retryable: false });
                }

                const html = await page.content();
                // 每页只 cheerio.load 一次，analyzeBlockedPage 与正式提取共用同一文档实例
                const $ = cheerio.load(html);
                const pageState = analyzeBlockedPage($, html);
                if (pageState.blocked) {
                    throw new AppError({
                        code: 'bot_challenge',
                        retryable: false,
                        engine: 'bing',
                        message: `Bing returned a verification or anti-bot page in Playwright mode (title: ${pageState.title || 'unknown'}, keywords: ${pageState.detectedKeywords.join(', ') || 'none'})`
                    });
                }
                if (pageState.hasResults && pageState.detectedKeywords.length > 0) {
                    console.warn(`Playwright Bing page contains suspicious keywords but also has results, skipping block detection: ${pageState.detectedKeywords.join(', ')}`);
                }

                const parsedPage = parseBingSearchResults(html, limit - allResults.length, $);
                if (!directAnswer && parsedPage.directAnswer) {
                    directAnswer = parsedPage.directAnswer;
                }
                const pageResults = parsedPage
                    .filter((result) => {
                        if (seenUrls.has(result.url)) {
                            return false;
                        }
                        seenUrls.add(result.url);
                        return true;
                    });

                allResults.push(...pageResults);

                if (pageResults.length === 0) {
                    console.error('⚠️ No more Bing results from Playwright mode, ending early.');
                    break;
                }
            }

            const finalResults = allResults.slice(0, limit) as EngineSearchResponse;
            if (directAnswer) {
                finalResults.directAnswer = directAnswer;
            }
            if (finalResults.length === 0 && hasSiteOperator(query)) {
                throw new AppError({
                    code: 'engine_parse_error',
                    retryable: false,
                    engine: 'bing',
                    hint: 'Retry without the site: prefix.',
                    message: 'Bing Playwright mode returned no results for a site:-restricted query. Retry without the site: prefix.'
                });
            }

            return finalResults;
        } catch (error) {
            if (signal?.aborted) {
                throw error;
            }
            if (shouldSuggestRemovingSiteOperator(query, error)) {
                throw new AppError({
                    code: 'engine_parse_error',
                    retryable: false,
                    engine: 'bing',
                    hint: 'Retry without the site: prefix.',
                    cause: error,
                    message: 'Bing Playwright mode did not return results for a site:-restricted query. Retry without the site: prefix.'
                });
            }
            throw error;
        } finally {
            signal?.removeEventListener('abort', onAbort);
            await safeReleasePage();
        }
    } finally {
        await session.release();
    }
}

export async function searchBing(
    query: string,
    limit: number,
    options?: { searchMode?: 'request' | 'auto' | 'playwright'; signal?: AbortSignal; timeRange?: 'day' | 'week' | 'month' | 'year' }
): Promise<SearchResult[]> {
    const effectiveSearchMode = options?.searchMode ?? getEngineSearchMode('bing', config);
    const signal = options?.signal;
    const timeRange = options?.timeRange;

    if (effectiveSearchMode === 'request') {
        return searchBingWithHttp(query, limit, signal, timeRange);
    }

    if (effectiveSearchMode === 'playwright') {
        return searchBingWithPlaywright(query, limit, signal);
    }

    try {
        const httpResults = await searchBingWithHttp(query, limit, signal, timeRange);
        // P0-2：cn.bing HTTP 对英文多词 query 常发生"首词漂移"（只按第一个词匹配，后续词全丢），
        // auto 模式下检测到首词漂移时同样触发 Playwright 交互回退。
        if (hasFirstTokenDrift(httpResults, query) && config.bingPlaywrightFallback && !signal?.aborted) {
            const canUsePlaywright = await isPlaywrightAvailable();
            if (canUsePlaywright && !signal?.aborted) {
                console.warn('Request-based Bing search returned first-token drift for multi-word query, falling back to Playwright mode');
                return searchBingWithPlaywright(query, limit, signal);
            }
        }
        return httpResults;
    } catch (requestError) {
        if (signal?.aborted) {
            throw requestError;
        }
        // SEARCH_MODE 控制：若 bing 不在 playwright 允许名单中（或显式禁用），
        // 反爬直接抛错，不启动重型浏览器。错误进入 partialFailures，配合 minResults 级联更轻量引擎补位。
        if (!config.bingPlaywrightFallback) {
            throw requestError;
        }

        const canUsePlaywright = await isPlaywrightAvailable();
        if (!canUsePlaywright || signal?.aborted) {
            throw requestError;
        }

        console.warn('Request-based Bing search failed, falling back to Playwright mode:', requestError);
        return searchBingWithPlaywright(query, limit, signal);
    }
}


