import { config, getEngineSearchMode } from '../../config.js';
import { SearchResult } from '../../types.js';
import { hasFirstTokenDrift } from '../../core/search/resultRanking.js';
import { isEngineCircuitOpen, tripEngineCircuit } from '../../core/search/engineCircuitBreaker.js';
import { isEngineBrowserOnly, setEngineBrowserOnly } from '../../core/search/engineBrowserOnly.js';
import { extractErrorCode, extractErrorStatus, isAppError } from '../../core/errors.js';
import { searchBingWithHttp } from './httpSearch.js';
import { searchBingWithPlaywright, searchBingWithPlaywrightFallback } from './browserFallback.js';
import { isPlaywrightAvailable } from './launchArgs.js';

// Re-exports for backward compatibility
export * from './blockedPage.js';
export * from './launchArgs.js';
export * from './browserFallback.js';
export * from './httpSearch.js';
export * from './parser.js';
export * from './query.js';

/**
 * Bing 遭遇 301 重定向/反爬时的软窗口策略（对齐 Brave 429）：
 * - cn.bing.com 遇到特定带引号/技术关键词时可能直接 301 重定向到 www.bing.com 空壳页；
 * - 遇到 301 或反爬拦截后，开启 180s「浏览器优先」窗口；
 * - 窗口期内调用 Bing 直接走 Playwright/CDP 兜底，不再花 2~3s 发送注定失败的 HTTP 请求；
 * - 窗口内兜底也失败则升级为硬熔断，由级联/路由换引擎；
 * - 180s 后自动恢复 HTTP 探测。
 */
export const BING_BROWSER_ONLY_MS = 180_000;

export function isBing301OrBlocked(error: unknown): boolean {
    const status = extractErrorStatus(error);
    const code = isAppError(error) ? error.code : extractErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (/aborted/i.test(message) || code === 'aborted') {
        return false;
    }
    return (
        status === 301 ||
        status === 302 ||
        status === 429 ||
        code === 'rate_limited' ||
        code === 'bot_challenge' ||
        /301|302|redirect|verification|anti-bot|captcha/i.test(message)
    );
}

/** 当前是否应跳过 HTTP、直接走 Playwright/CDP 兜底（软窗口 + 未禁用兜底） */
export function shouldPreferBingBrowser(): boolean {
    return Boolean(config.bingPlaywrightFallback) && isEngineBrowserOnly('bing');
}

/**
 * 漂移回退的取舍（纯函数，便于回归测试）：
 * 兜底有结果就用兜底；否则**保留 HTTP 已拿到的结果**——它们是可用的，
 * 只是可能只匹配了首词。以前这里直接 return 兜底结果，等于把可用结果整批扔掉。
 */
export function resolveBingDriftOutcome(
    httpResults: SearchResult[],
    fallbackResults: SearchResult[] | undefined
): { results: SearchResult[]; keptHttpFallback: boolean } {
    if (fallbackResults && fallbackResults.length > 0) {
        return { results: fallbackResults, keptHttpFallback: false };
    }
    return { results: httpResults, keptHttpFallback: httpResults.length > 0 };
}

export async function searchBing(
    query: string,
    limit: number,
    options?: {
        searchMode?: 'request' | 'auto' | 'playwright';
        signal?: AbortSignal;
        timeRange?: 'day' | 'week' | 'month' | 'year';
        requestContext?: { addWarning?: (warning: string) => void };
    }
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

    // 软窗口内：HTTP 必然继续吃 301/反爬，直接走 Playwright/CDP 兜底（跳过 HTTP 请求）
    if (shouldPreferBingBrowser() && !isEngineCircuitOpen('bing')) {
        const canUsePlaywright = await isPlaywrightAvailable();
        if (canUsePlaywright && !signal?.aborted) {
            try {
                const browserResults = await searchBingWithPlaywrightFallback(query, limit, signal);
                if (browserResults && browserResults.length > 0) {
                    return browserResults;
                }
            } catch (browserError) {
                if (signal?.aborted) {
                    throw browserError;
                }
                console.warn('Bing Playwright fallback failed during browser-only window:', browserError instanceof Error ? browserError.message : String(browserError));
                tripEngineCircuit('bing');
                throw browserError;
            }
        }
    }

    try {
        const httpResults = await searchBingWithHttp(query, limit, signal, timeRange);
        // P0-2：cn.bing HTTP 对英文多词 query 常发生“首词漂移”（只按第一个词匹配，后续词全丢），
        // auto 模式下检测到首词漂移时同样触发浏览器交互回退（CDP）。
        // 熔断冷却期不要为「注定失败」的请求再花 20s 起浏览器；
        // 冷却本身就是失败学习的结果，浏览器兜底救不回来，只会把 200ms 的失败拉长到 20s。
        if (hasFirstTokenDrift(httpResults, query) && config.bingPlaywrightFallback && !signal?.aborted
            && !isEngineCircuitOpen('bing')) {
            const canUsePlaywright = await isPlaywrightAvailable();
            if (canUsePlaywright && !signal?.aborted) {
                console.warn('Request-based Bing search returned first-token drift for multi-word query, falling back to Playwright mode');
                // 兜底失败/超预算时保留已拿到的 HTTP 结果，并显式标记为 degraded
                const fallbackResults = await searchBingWithPlaywrightFallback(query, limit, signal);
                const outcome = resolveBingDriftOutcome(httpResults, fallbackResults);
                if (!outcome.keptHttpFallback) {
                    return outcome.results;
                }
                options?.requestContext?.addWarning?.(
                    'Bing kept HTTP results that may match only the first query token: '
                    + 'first-token drift was detected and the Playwright fallback produced no results within its budget.'
                );
                return outcome.results;
            }
        }
        return httpResults;
    } catch (requestError) {
        if (signal?.aborted) {
            throw requestError;
        }

        // 遇 301 或反爬拦截：对齐 Brave 429 机制，开启 180s 浏览器优先窗口
        if (isBing301OrBlocked(requestError)) {
            setEngineBrowserOnly('bing', BING_BROWSER_ONLY_MS);
        }

        // SEARCH_MODE 控制：若 bing 不在 playwright 允许名单中（或显式禁用），
        // 反爬直接抛错，不启动重型浏览器。错误进入 partialFailures，配置 minResults 级联更轻量引擎补位。
        if (!config.bingPlaywrightFallback) {
            tripEngineCircuit('bing');
            throw requestError;
        }

        // 冷却期内直接抛错，交给级联换更轻量的引擎，而不是起浏览器再等一次超时。
        if (isEngineCircuitOpen('bing')) {
            throw requestError;
        }

        const canUsePlaywright = await isPlaywrightAvailable();
        if (!canUsePlaywright || signal?.aborted) {
            tripEngineCircuit('bing');
            throw requestError;
        }

        console.warn('Request-based Bing search failed, falling back to Playwright mode:', requestError);
        // 同样走带预算的兜底；兜底失败则 tripEngineCircuit('bing') 并抛原始错误（让级联换更轻量的引擎）
        try {
            const fallbackResults = await searchBingWithPlaywrightFallback(query, limit, signal);
            if (fallbackResults && fallbackResults.length > 0) {
                return fallbackResults;
            }
        } catch (fallbackError) {
            if (signal?.aborted) {
                throw fallbackError;
            }
            console.warn('Bing Playwright fallback failed:', fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
        }

        // 兜底失败或无结果，触发熔断并抛错
        tripEngineCircuit('bing');
        throw requestError;
    }
}
