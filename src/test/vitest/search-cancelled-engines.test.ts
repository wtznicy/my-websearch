import { describe, expect, it } from 'vitest';
import { createSearchService, type SearchEngineExecutorMap } from '../../core/search/searchService.js';
import type { SearchResult } from '../../types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeResult = (engine: string, index: number, query = ''): SearchResult => ({
    title: `${engine} ${query} result number ${index + 1}`.trim(),
    url: `https://example.com/${engine}/${index}`,
    description: `A substantive snippet for ${engine} ${query} result ${index}`.trim(),
    source: 'example.com',
    engine
});

/**
 * 回归：多引擎并发时慢引擎被 abort，不能表现成「返回 0 条」。
 * - 显式点名引擎：禁用早退，慢引擎必须完整跑完；
 * - 非显式（auto/minResults）：允许早退，但被取消的引擎要出现在 cancelledEngines + warning 里。
 */
describe('search cancellation reporting', () => {
    const makeService = () => {
        const engineMap: SearchEngineExecutorMap = {
            bing: async (q, _limit) => Array.from({ length: 2 }, (_, i) => makeResult('bing', i, q)),
            duckduckgo: async (q, _limit) => {
                await sleep(2500);
                return Array.from({ length: 2 }, (_, i) => makeResult('duckduckgo', i, q));
            }
        };
        return createSearchService(engineMap);
    };

    it('does not cancel explicitly requested engines', async () => {
        const service = makeService();
        const startedAt = Date.now();
        const result = await service.execute({
            query: 'explicit engines test',
            engines: ['bing', 'duckduckgo'],
            requestedEngines: ['bing', 'duckduckgo'],
            limit: 5,
            minResults: 1
        });

                expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1400);
        expect(result.results.some((item) => item.engine === 'duckduckgo')).toBe(true);
        expect(result.cancelledEngines).toBeUndefined();
    }, 10_000);

    it('reports engines cancelled by early return instead of pretending they returned zero', async () => {
        const service = makeService();
        const result = await service.execute({
            query: 'early return cancellation test',
            engines: ['bing', 'duckduckgo'],
            limit: 5,
            minResults: 1
        });

                expect(result.cancelledEngines?.map((item) => item.engine)).toContain('duckduckgo');
        expect(result.results.some((item) => item.engine === 'duckduckgo')).toBe(false);
        expect(result.warnings?.some((warning) => /cancelled after enough results/i.test(warning))).toBe(true);
    }, 10_000);
});
