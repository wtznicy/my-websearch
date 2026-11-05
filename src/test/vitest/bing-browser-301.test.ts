import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchBing } from '../../engines/bing/bing.js';
import * as httpSearchModule from '../../engines/bing/httpSearch.js';
import * as browserFallbackModule from '../../engines/bing/browserFallback.js';
import * as launchArgsModule from '../../engines/bing/launchArgs.js';
import { isEngineBrowserOnly, resetEngineBrowserOnly } from '../../core/search/engineBrowserOnly.js';
import { isEngineCircuitOpen, resetEngineCircuits } from '../../core/search/engineCircuitBreaker.js';
import { config } from '../../config.js';
import type { SearchResult } from '../../types.js';

const mockResult = (title: string): SearchResult => ({
    title,
    url: `https://example.com/${encodeURIComponent(title)}`,
    description: 'desc',
    source: 'bing.com',
    engine: 'bing'
});

describe('searchBing 301 browser-only and Playwright fallback', () => {
    beforeEach(() => {
        resetEngineBrowserOnly();
        resetEngineCircuits();
        config.bingPlaywrightFallback = true;
        vi.spyOn(launchArgsModule, 'isPlaywrightAvailable').mockResolvedValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetEngineBrowserOnly();
        resetEngineCircuits();
    });

    it('opens 180s browser-only window on 301 and recovers via Playwright fallback', async () => {
        const httpSpy = vi.spyOn(httpSearchModule, 'searchBingWithHttp').mockRejectedValue(
            Object.assign(new Error('Request failed with status code 301'), {
                status: 301,
                response: { status: 301 }
            })
        );
        const fallbackSpy = vi.spyOn(browserFallbackModule, 'searchBingWithPlaywrightFallback').mockResolvedValue([
            mockResult('Playwright Result 1')
        ]);

        expect(isEngineBrowserOnly('bing')).toBe(false);

        const results = await searchBing('test query', 5);
        expect(results).toHaveLength(1);
        expect(results[0]?.title).toBe('Playwright Result 1');

        // 验证进入 180s 软窗口
        expect(isEngineBrowserOnly('bing')).toBe(true);
        expect(httpSpy).toHaveBeenCalledTimes(1);
        expect(fallbackSpy).toHaveBeenCalledTimes(1);

        // 窗口期内后续查询：直接走 Playwright fallback，跳过 HTTP
        httpSpy.mockClear();
        fallbackSpy.mockClear();

        const resultsSecond = await searchBing('second query', 5);
        expect(resultsSecond).toHaveLength(1);
        expect(httpSpy).not.toHaveBeenCalled();
        expect(fallbackSpy).toHaveBeenCalledTimes(1);
    });

    it('trips circuit breaker if fallback also fails during 301', async () => {
        vi.spyOn(httpSearchModule, 'searchBingWithHttp').mockRejectedValue(
            Object.assign(new Error('Request failed with status code 301'), { status: 301 })
        );
        vi.spyOn(browserFallbackModule, 'searchBingWithPlaywrightFallback').mockResolvedValue([]);

        await expect(searchBing('test query', 5)).rejects.toThrow();

        // 验证触发熔断
        expect(isEngineCircuitOpen('bing')).toBe(true);
    });
});
