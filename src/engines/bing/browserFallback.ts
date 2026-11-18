import * as cheerio from 'cheerio';
import { config } from '../../config.js';
import { AppError } from '../../core/errors.js';
import { getNumber } from '../../config/env.js';
import { EngineSearchResponse, SearchResult } from '../../types.js';
import {
    acquirePooledPlaywrightPage,
    loadPlaywrightClient,
    openPlaywrightBrowser,
    PlaywrightLocatorLike,
    PlaywrightPageLike
} from '../../utils/playwrightClient.js';
import { prepareStealthPage } from '../../utils/browserStealth.js';
import { analyzeBlockedPage, getBingHomeUrl } from './blockedPage.js';
import {
    BROWSER_CONTEXT_OPTIONS,
    buildBrowserLaunchArgs,
    getEffectiveBingPlaywrightHeadless,
    shouldUseHiddenHeadedBingBrowser
} from './launchArgs.js';
import { parseBingSearchResults } from './parser.js';
import { hasSiteOperator, shouldSuggestRemovingSiteOperator } from './query.js';

export const NEXT_PAGE_SELECTORS = [
    'a.sb_pagN',
    '.b_pag a.sb_pagN',
    'a[title="Next page"]',
    'a[aria-label="Next page"]'
];

export function getBingUiTimeoutMs(): number {
    return Math.min(config.playwrightNavigationTimeoutMs, 15000);
}

export async function waitForBingResultsReady(page: PlaywrightPageLike): Promise<void> {
    await page.waitForSelector('#b_results, .b_algo, #b_content', {
        timeout: getBingUiTimeoutMs()
    });
}

export async function getBingResultsSignature(page: PlaywrightPageLike): Promise<string> {
    return page.evaluate<string>(() => {
        const container = document.querySelector('#b_results') || document.querySelector('#b_content');
        return (container?.textContent || '').replace(/\s+/g, ' ').trim();
    }).catch(() => '');
}

export async function waitForBingResultsChanged(page: PlaywrightPageLike, previousSignature: string): Promise<void> {
    await page.waitForFunction((previous: string) => {
        const container = document.querySelector('#b_results') || document.querySelector('#b_content');
        const current = (container?.textContent || '').replace(/\s+/g, ' ').trim();
        return current.length > 0 && current !== previous;
    }, previousSignature, { timeout: getBingUiTimeoutMs() });
}

export async function waitForAnyDeterministicSignal(signals: Array<Promise<unknown>>, timeoutMs: number): Promise<boolean> {
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

export function normalizeBingQueryForUrl(query: string): string {
    return query
        .trim()
        .replace(/["'“”‘’]/g, '')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

export function doesBingUrlMatchQuery(url: string, query: string): boolean {
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

export async function waitForBingNextPageNavigation(page: PlaywrightPageLike, previousUrl: string): Promise<void> {
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

export function isBingUrl(url: string): boolean {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return hostname === 'bing.com'
            || hostname.endsWith('.bing.com');
    } catch {
        return false;
    }
}

export function getBingSearchUrl(query: string): string {
    const homeUrl = getBingHomeUrl();
    try {
        const url = new URL(homeUrl);
        url.pathname = '/search';
        url.searchParams.set('q', query);
        return url.toString();
    } catch {
        return `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN`;
    }
}

export async function openBingAndSearch(page: PlaywrightPageLike, query: string): Promise<void> {
    const searchUrl = getBingSearchUrl(query);
    await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.playwrightNavigationTimeoutMs
    });
    await waitForBingResultsReady(page);
}

export async function goToNextResultsPage(page: PlaywrightPageLike): Promise<boolean> {
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

export async function searchBingWithPlaywright(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
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
            message: 'Browser driver is not available for the Bing fallback. The default CDP driver needs a Chromium-based browser (Chrome/Edge/Chromium/Brave/Vivaldi/Opera) – install one or set CHROME_PATH; BROWSER_DRIVER=playwright additionally requires the playwright-core package.'
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

/** 浏览器兜底（CDP）的独立预算：不能让它把整个搜索 deadline 吃光（默认 6s，可由 BING_BROWSER_BUDGET_MS 或 BING_PLAYWRIGHT_BUDGET_MS 覆盖）*/
export const BING_PLAYWRIGHT_FALLBACK_BUDGET_MS = (() => {
    const parsed = getNumber('BING_BROWSER_BUDGET_MS', getNumber('BING_PLAYWRIGHT_BUDGET_MS', 6000, { min: 1000, integer: true }), { min: 1000, integer: true });
    return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : 6000;
})();

export async function searchBingWithPlaywrightFallback(
    query: string,
    limit: number,
    signal?: AbortSignal
): Promise<SearchResult[] | undefined> {
    if (signal?.aborted) {
        return undefined;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    let timer: NodeJS.Timeout | undefined;
    const budgetExceeded = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
            controller.abort(new Error(`Bing Playwright fallback exceeded ${BING_PLAYWRIGHT_FALLBACK_BUDGET_MS}ms budget`));
            resolve(undefined);
        }, BING_PLAYWRIGHT_FALLBACK_BUDGET_MS);
    });
    const attempt = searchBingWithPlaywright(query, limit, controller.signal)
        .catch((error) => {
            if (!signal?.aborted) {
                console.warn(
                    '[bing] Playwright fallback failed; keeping HTTP results:',
                    error instanceof Error ? error.message : String(error)
                );
            }
            return undefined;
        });

    try {
        const results = await Promise.race([attempt, budgetExceeded]);
        if (!results || results.length === 0 || controller.signal.aborted) {
            return undefined;
        }
        return results;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
