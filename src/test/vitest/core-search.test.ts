import { describe, it, expect, afterEach } from 'vitest';
import type { SearchResult } from '../../types.js';
import { resetEngineCircuits, tripEngineCircuit } from '../../core/search/engineCircuitBreaker.js';
import {
    SUPPORTED_SEARCH_ENGINES,
    distributeLimit,
    normalizeEngineName,
    resolveRequestedEngines
} from '../../core/search/searchEngines.js';
import {
    createSearchService,
    mergeSearchResults,
    normalizeResultUrl,
    SearchTtlCache
} from '../../core/search/searchService.js';
import type { SearchEngineExecutorMap } from '../../core/search/searchService.js';

function createResult(engine: string, index: number): SearchResult {
    return {
        title: `${engine}-${index}`,
        url: `https://${engine}.example.com/${index}`,
        description: `result ${index} from ${engine}`,
        source: `${engine}.example.com`,
        engine
    };
}

afterEach(() => {
    resetEngineCircuits();
});

describe('search engine helpers', () => {
    it('normalizes engine aliases and exposes the supported list', () => {
        expect(normalizeEngineName('Bing')).toBe('bing');
        expect(normalizeEngineName('duck-duck-go')).toBe('duckduckgo');
        expect(normalizeEngineName('StartPage')).toBe('startpage');
        expect(normalizeEngineName('sou-gou')).toBe('sogou');
        expect(normalizeEngineName('搜狗')).toBe('sogou');
        expect([...SUPPORTED_SEARCH_ENGINES]).toEqual([
            'baidu', 'bing', 'bing-news', 'csdn', 'duckduckgo', 'exa', 'brave', 'juejin',
            'startpage', 'yahoo', 'sogou', 'github', 'stackoverflow', 'hackernews', 'arxiv', 'code'
        ]);
    });

    it('distributes limits across engines', () => {
        expect(distributeLimit(10, 3)).toEqual([4, 3, 3]);
        expect(distributeLimit(2, 5)).toEqual([1, 1, 0, 0, 0]);
    });

    it('resolves requested engines against the allowlist and default', () => {
        expect(resolveRequestedEngines(['bing', 'startpage'], [], 'bing')).toEqual(['bing', 'startpage']);
        expect(resolveRequestedEngines(['bing', 'startpage'], ['startpage'], 'bing')).toEqual(['startpage']);
        expect(resolveRequestedEngines(['bing'], ['startpage'], 'startpage')).toEqual(['startpage']);
    });
});

describe('search service execution', () => {
    it('runs engines, trims the query, keeps successes and records partial failures', async () => {
        const seenCalls: Array<{ engine: string; query: string; limit: number; searchMode?: string }> = [];
        const engineMap: SearchEngineExecutorMap = {
            bing: async (query, limit, context) => {
                seenCalls.push({ engine: 'bing', query, limit, searchMode: context?.searchMode });
                return Array.from({ length: limit }, (_, index) => createResult('bing', index + 1));
            },
            startpage: async (query, limit, context) => {
                seenCalls.push({ engine: 'startpage', query, limit, searchMode: context?.searchMode });
                throw new Error(`blocked for ${query} (${limit})`);
            }
        };

        const service = createSearchService(engineMap);
        const result = await service.execute({
            query: '  open web search  ',
            engines: ['bing', 'startpage'],
            limit: 3,
            minResults: 5,
            searchMode: 'playwright'
        });

        expect(result.query).toBe('open web search');
        expect(result.totalResults).toBe(3);
        expect(result.partialFailures).toHaveLength(1);
        expect(result.partialFailures[0].engine).toBe('startpage');
        expect(result.partialFailures[0].code).toBe('engine_error');
        expect(seenCalls.map((call) => `${call.engine}:${call.query}:${call.limit}:${call.searchMode ?? 'none'}`)).toEqual([
            'bing:open web search:3:playwright',
            'startpage:open web search:3:playwright',
            'startpage:open web search:3:playwright',
            'startpage:open web search:3:playwright'
        ]);
    });

    it('treats request-level searchMode=auto like an omitted mode', async () => {
        const seenCalls: Array<{ searchMode?: string }> = [];
        const service = createSearchService({
            bing: async (query, limit, context) => {
                seenCalls.push({ searchMode: context?.searchMode });
                return Array.from({ length: limit }, (_, index) => createResult(`${query}:${context?.searchMode ?? 'none'}`, index + 1));
            }
        });

        await service.execute({ query: 'open web search', engines: ['bing'], limit: 1, searchMode: 'auto' });
        expect(seenCalls[0].searchMode).toBeUndefined();
    });

    it('validates empty and over-long queries', async () => {
        const service = createSearchService({
            bing: async (query, limit) => Array.from({ length: limit }, (_, index) => createResult('bing', index + 1))
        });

        await expect(service.execute({ query: '   ', engines: ['bing'], limit: 1 }))
            .rejects.toThrow('Query string cannot be empty');
        await expect(service.execute({ query: 'x'.repeat(501), engines: ['bing'], limit: 1 }))
            .rejects.toThrow(/Query string too long/);
        await expect(service.execute({ query: 'x'.repeat(500), engines: ['bing'], limit: 1 }))
            .resolves.toMatchObject({ totalResults: 1 });
    });

    it('grants the full limit per engine and reports empty-result engines', async () => {
        const called: string[] = [];
        const service = createSearchService({
            bing: async (_query, limit) => {
                called.push(`bing:${limit}`);
                return [{ title: 'a', url: 'https://a.com', description: '', source: 'a.com', engine: 'bing' }];
            },
            duckduckgo: async (_query, limit) => {
                called.push(`duckduckgo:${limit}`);
                return [];
            },
            startpage: async (_query, limit) => {
                called.push(`startpage:${limit}`);
                return [];
            }
        });

        const result = await service.execute({ query: 'q', engines: ['bing', 'duckduckgo', 'startpage'], limit: 1 });
        expect([...called].sort()).toEqual(['bing:1', 'duckduckgo:1', 'startpage:1']);
        expect(result.partialFailures).toHaveLength(2);
        expect(result.partialFailures.every((failure) => failure.code === 'no_results')).toBe(true);

        const result2 = await service.execute({ query: 'q2', engines: ['bing', 'duckduckgo'], limit: 3 });
        expect(result2.partialFailures).toHaveLength(1);
        expect(result2.partialFailures[0].engine).toBe('duckduckgo');
    });

    it('skips circuit-open engines and transfers quota, falling back when all are open', async () => {
        const calls: Record<string, number[]> = { bing: [], brave: [] };
        const service = createSearchService({
            bing: async (_query, limit) => {
                calls.bing.push(limit);
                return Array.from({ length: limit }, (_, index) => createResult('bing', index + 1));
            },
            brave: async (_query, limit) => {
                calls.brave.push(limit);
                return [createResult('brave', 1)];
            }
        });

        tripEngineCircuit('brave');
        const result = await service.execute({ query: 'circuit query', engines: ['bing', 'brave'], limit: 6 });
        expect(calls.brave).toHaveLength(0);
        expect(calls.bing[0]).toBe(6);
        expect(result.partialFailures.some((failure) => failure.engine === 'brave' && failure.code === 'circuit_open')).toBe(true);
        expect(result.engines.join(',')).toBe('bing');
        expect(result.results).toHaveLength(6);

        resetEngineCircuits();
        tripEngineCircuit('bing');
        tripEngineCircuit('brave');
        const allOpen = await service.execute({ query: 'all open', engines: ['bing', 'brave'], limit: 4 });
        expect(allOpen.engines).toHaveLength(2);
    });

    it('cascades to other engines when minResults is not met', async () => {
        const called: string[] = [];
        const engineMap: SearchEngineExecutorMap = {
            bing: async (_query, _limit) => {
                called.push('bing');
                return [{ ...createResult('bing', 1), title: 'cascade me result', description: 'cascade me guide' }];
            },
            startpage: async () => {
                called.push('startpage');
                throw new Error('startpage blocked');
            },
            duckduckgo: async (_query, limit) => {
                called.push(`duckduckgo:${limit}`);
                return Array.from({ length: limit }, (_, index) => createResult('duckduckgo', index + 1));
            }
        };

        const service = createSearchService(engineMap);
        const result = await service.execute({ query: 'cascade me', engines: ['bing', 'startpage'], limit: 5, minResults: 3 });
        expect(result.totalResults).toBeGreaterThanOrEqual(3);
        expect(result.cascadedEngines).toContain('duckduckgo');
        expect(called).toContain('duckduckgo:2');
        expect(result.partialFailures).toHaveLength(1);
        expect(result.partialFailures[0].engine).toBe('startpage');

        const noCascade = await service.execute({ query: 'cascade me', engines: ['bing'], limit: 5 });
        expect(noCascade.cascadedEngines).toBeUndefined();
    });

    it('clearCache invalidates the TTL cache', async () => {
        let callCount = 0;
        const service = createSearchService({
            bing: async (_query, limit) => {
                callCount += 1;
                return Array.from({ length: limit }, (_, index) => createResult('bing', index + 1));
            }
        });

        const input = { query: 'clear me', engines: ['bing'], limit: 2 };
        await service.execute(input);
        await service.execute(input);
        expect(callCount).toBe(1);

        service.clearCache();
        await service.execute(input);
        expect(callCount).toBe(2);
        expect(service.cacheSize).toBe(1);
    });

    it('partial failures carry an actionable hint', async () => {
        const service = createSearchService({
            bing: async () => {
                throw new Error('temporary outage');
            }
        });
        const result = await service.execute({ query: 'hint me', engines: ['bing'], limit: 1 });
        expect(result.partialFailures).toHaveLength(1);
        expect(result.partialFailures[0].message).toContain('Hint:');
    });
});

describe('result normalization and merging', () => {
    it('strips tracking params and hash for dedup', () => {
        expect(normalizeResultUrl('https://a.com/p?utm_source=x&id=1#sec')).toBe(normalizeResultUrl('https://a.com/p?id=1'));
        expect(normalizeResultUrl('https://a.com/p?utm_source=x')).toBe(normalizeResultUrl('https://a.com/p'));
    });

    it('dedups shared URLs and ranks multi-engine hits first', () => {
        const bing: SearchResult[] = [
            { title: 'A-bing', url: 'https://example.com/a', description: 'd', source: 'example.com', engine: 'bing' },
            { title: 'B', url: 'https://example.com/b', description: 'd', source: 'example.com', engine: 'bing' }
        ];
        const startpage: SearchResult[] = [
            { title: 'A-startpage', url: 'https://example.com/a?utm_source=sp', description: 'd', source: 'example.com', engine: 'startpage' },
            { title: 'C', url: 'https://example.com/c', description: 'd', source: 'example.com', engine: 'startpage' }
        ];

        const merged = mergeSearchResults([bing, startpage]);
        expect(merged).toHaveLength(3);
        expect(merged[0].url).toBe('https://example.com/a');
        expect(merged[0].title).toBe('A-bing');
        expect(merged.map((result) => result.url)).toEqual([
            'https://example.com/a',
            'https://example.com/b',
            'https://example.com/c'
        ]);
        expect(mergeSearchResults([bing]).map((result) => result.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
    });
});

describe('SearchTtlCache', () => {
    it('deduplicates identical requests and expires entries', async () => {
        let callCount = 0;
        const service = createSearchService({
            bing: async (_query, limit) => {
                callCount += 1;
                return Array.from({ length: limit }, (_, index) => createResult('bing', index + 1));
            }
        });

        const input = { query: 'cache me', engines: ['bing'], limit: 2 };
        await service.execute(input);
        await service.execute(input);
        expect(callCount).toBe(1);

        await service.execute({ ...input, engines: ['bing', 'startpage'] });
        expect(callCount).toBe(2);

        let failCount = 0;
        const failingService = createSearchService({
            bing: async () => {
                failCount += 1;
                throw new Error('temporary outage');
            }
        });
        const failingInput = { query: 'dont cache me', engines: ['bing'], limit: 1 };
        await failingService.execute(failingInput);
        await failingService.execute(failingInput);
        expect(failCount).toBe(6);

        const cache = new SearchTtlCache(100);
        const cachedResults = Array.from({ length: 2 }, (_, index) => createResult('bing', index + 1));
        cache.set(input, { query: 'x', engines: ['bing'], totalResults: 2, results: cachedResults, partialFailures: [] });
        expect(cache.get(input)).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(cache.get(input)).toBeUndefined();
    });

    it('misses when the cached requestedLimit is smaller than the new limit', async () => {
        let callCount = 0;
        const service = createSearchService({
            bing: async () => {
                callCount += 1;
                const count = callCount === 1 ? 7 : 10;
                return Array.from({ length: count }, (_, index) => createResult('bing', index + 1));
            }
        });

        const r1 = await service.execute({ query: 'insufficient', engines: ['bing'], limit: 7 });
        expect(r1.totalResults).toBe(7);
        expect(callCount).toBe(1);

        const r2 = await service.execute({ query: 'insufficient', engines: ['bing'], limit: 6 });
        expect(r2.totalResults).toBe(6);
        expect(callCount).toBe(1);

        const r3 = await service.execute({ query: 'insufficient', engines: ['bing'], limit: 8 });
        expect(callCount).toBe(2);
        expect(r3.totalResults).toBe(8);
    });

    it('does not thrash the cache for cold queries with fewer results than limit', async () => {
        let callCount = 0;
        const service = createSearchService({
            bing: async () => {
                callCount += 1;
                return Array.from({ length: 3 }, (_, index) => createResult('bing', index + 1));
            }
        });

        expect((await service.execute({ query: 'cold query', engines: ['bing'], limit: 5 })).totalResults).toBe(3);
        expect(callCount).toBe(1);
        expect((await service.execute({ query: 'cold query', engines: ['bing'], limit: 5 })).totalResults).toBe(3);
        expect(callCount).toBe(1);
        expect((await service.execute({ query: 'cold query', engines: ['bing'], limit: 4 })).totalResults).toBe(3);
        expect(callCount).toBe(1);

        await service.execute({ query: 'cold query', engines: ['bing'], limit: 8 });
        expect(callCount).toBe(2);
    });
});
