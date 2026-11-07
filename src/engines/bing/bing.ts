import { config, getEngineSearchMode } from '../../config.js';
import { SearchResult } from '../../types.js';
import { hasFirstTokenDrift } from '../../core/search/resultRanking.js';
import { isEngineCircuitOpen, tripEngineCircuit } from '../../core/search/engineCircuitBreaker.js';
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

    try {
        const httpResults = await searchBingWithHttp(query, limit, signal, timeRange);
        // P0-2：cn.bing HTTP 对英文多词 query 常发生“首词漂移”（只按第一个词匹配，后续词全丢），
        // auto 模式下检测到首词漂移时同样触发浏览器交互回退（CDP）。
        // 熔断冷却期不要为「注定失败」的请求再花 20s 起浏览器；
        // 冷却本身就是失败学习的结果，浏览器兜底救不回来，只会把 200ms 的失败拉长到 20s。
        if (hasFirstTokenDrift(httpResults, query) && !signal?.aborted && !isEngineCircuitOpen('bing')) {
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
        // 走带预算的兜底；兜底失败则 tripEngineCircuit('bing') 并抛原始错误（让级联换更轻量的引擎）
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
