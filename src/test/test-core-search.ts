import { SearchResult } from '../types.js';
import {
    SUPPORTED_SEARCH_ENGINES,
    distributeLimit,
    normalizeEngineName,
    resolveRequestedEngines
} from '../core/search/searchEngines.js';
import {
    createSearchService,
    mergeSearchResults,
    normalizeResultUrl,
    SearchTtlCache,
    SearchEngineExecutorMap
} from '../core/search/searchService.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

function assertEqualArray(actual: unknown[], expected: unknown[], label: string): void {
    const ok = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
    if (!ok) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function createResult(engine: string, index: number): SearchResult {
    return {
        title: `${engine}-${index}`,
        url: `https://${engine}.example.com/${index}`,
        description: `result ${index} from ${engine}`,
        source: `${engine}.example.com`,
        engine
    };
}

function testNormalizeEngineName(): void {
    assertEqual(normalizeEngineName('Bing'), 'bing', 'normalizes Bing');
    assertEqual(normalizeEngineName('duck-duck-go'), 'duckduckgo', 'normalizes duckduckgo alias');
    assertEqual(normalizeEngineName('StartPage'), 'startpage', 'normalizes StartPage');
    assertEqual(normalizeEngineName('sou-gou'), 'sogou', 'normalizes sou-gou alias');
    assertEqual(normalizeEngineName('搜狗'), 'sogou', 'normalizes Chinese Sogou alias');
    assertEqualArray([...SUPPORTED_SEARCH_ENGINES], [
        'baidu',
        'bing',
        'csdn',
        'duckduckgo',
        'exa',
        'brave',
        'juejin',
        'startpage',
        'sogou'
    ], 'supported engines list');
    console.log('✅ normalizeEngineName and supported engines');
}

function testDistributeLimit(): void {
    assertEqualArray(distributeLimit(10, 3), [4, 3, 3], 'distributes remainder to leading engines');
    assertEqualArray(distributeLimit(2, 5), [1, 1, 0, 0, 0], 'supports fewer results than engines');
    console.log('✅ distributeLimit');
}

function testResolveRequestedEngines(): void {
    assertEqualArray(
        resolveRequestedEngines(['bing', 'startpage'], [], 'bing'),
        ['bing', 'startpage'],
        'keeps requested engines when unrestricted'
    );
    assertEqualArray(
        resolveRequestedEngines(['bing', 'startpage'], ['startpage'], 'bing'),
        ['startpage'],
        'filters to allowed engines'
    );
    assertEqualArray(
        resolveRequestedEngines(['bing'], ['startpage'], 'startpage'),
        ['startpage'],
        'falls back to default allowed engine when all requested engines are filtered'
    );
    console.log('✅ resolveRequestedEngines');
}

async function testSearchServiceExecution(): Promise<void> {
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
        searchMode: 'playwright'
    });

    assertEqual(result.query, 'open web search', 'trims query');
    assertEqual(result.totalResults, 2, 'keeps successful engine results');
    assertEqual(result.partialFailures.length, 1, 'captures one partial failure');
    assertEqual(result.partialFailures[0].engine, 'startpage', 'records failed engine');
    assertEqual(result.partialFailures[0].code, 'engine_error', 'uses stable partial failure code');
    assertEqualArray(
        seenCalls.map(call => `${call.engine}:${call.query}:${call.limit}:${call.searchMode ?? 'none'}`),
        ['bing:open web search:2:playwright', 'startpage:open web search:1:playwright', 'startpage:open web search:1:playwright', 'startpage:open web search:1:playwright'],
        'passes trimmed query, distributed limits, and request-level search mode (startpage retried 3x then failed)'
    );

    console.log('✅ search service executes with partial failures');
}

async function testSearchServiceAutoModeUsesRuntimeDefault(): Promise<void> {
    const seenCalls: Array<{ searchMode?: string }> = [];
    const service = createSearchService({
        bing: async (query, limit, context) => {
            seenCalls.push({ searchMode: context?.searchMode });
            return Array.from({ length: limit }, (_, index) => createResult(`${query}:${context?.searchMode ?? 'none'}`, index + 1));
        }
    });

    await service.execute({
        query: 'open web search',
        engines: ['bing'],
        limit: 1,
        searchMode: 'auto'
    });

    assertEqual(seenCalls[0].searchMode, undefined, 'request-level auto should be treated like omitted search mode');
    console.log('✅ search service treats request-level auto as runtime default');
}

async function testSearchServiceValidation(): Promise<void> {
    const service = createSearchService({});

    let threw = false;
    try {
        await service.execute({
            query: '   ',
            engines: ['bing'],
            limit: 1
        });
    } catch (error) {
        threw = error instanceof Error && error.message === 'Query string cannot be empty';
    }

    assert(threw, 'empty trimmed query should fail');
    console.log('✅ search service validates empty query');
}

function testNormalizeResultUrl(): void {
    assertEqual(
        normalizeResultUrl('https://a.com/p?utm_source=x&id=1#sec'),
        normalizeResultUrl('https://a.com/p?id=1'),
        'strips tracking params and hash for dedup'
    );
    assertEqual(
        normalizeResultUrl('https://a.com/p?utm_source=x'),
        normalizeResultUrl('https://a.com/p'),
        'removes utm_ params'
    );
    console.log('✅ normalizeResultUrl');
}

function testMergeSearchResultsDedupAndRank(): void {
    // bing 和 startpage 都返回 url A；只有 bing 返回 url B；只有 startpage 返回 url C
    const bing = [
        { title: 'A-bing', url: 'https://example.com/a', description: 'd', source: 'example.com', engine: 'bing' } as SearchResult,
        { title: 'B', url: 'https://example.com/b', description: 'd', source: 'example.com', engine: 'bing' } as SearchResult
    ];
    const startpage = [
        { title: 'A-startpage', url: 'https://example.com/a?utm_source=sp', description: 'd', source: 'example.com', engine: 'startpage' } as SearchResult,
        { title: 'C', url: 'https://example.com/c', description: 'd', source: 'example.com', engine: 'startpage' } as SearchResult
    ];

    const merged = mergeSearchResults([bing, startpage]);
    assertEqual(merged.length, 3, 'deduplicates shared URL across engines');
    assertEqual(merged[0].url, 'https://example.com/a', 'result hit by both engines ranks first');
    assertEqual(merged[0].title, 'A-bing', 'keeps first-seen engine result for shared URL');
    assertEqualArray(
        merged.map(r => r.url),
        ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
        'stable order for unique results after shared winner'
    );

    const single = mergeSearchResults([bing]);
    assertEqualArray(
        single.map(r => r.url),
        ['https://example.com/a', 'https://example.com/b'],
        'single engine preserves original order'
    );
    console.log('✅ mergeSearchResults dedups and ranks by multi-engine hits');
}

async function testSearchTtlCache(): Promise<void> {
    let callCount = 0;
    const service = createSearchService({
        bing: async (query, limit) => {
            callCount += 1;
            return Array.from({ length: limit }, (_, index) => createResult('bing', index + 1));
        }
    });

    const input = { query: 'cache me', engines: ['bing'], limit: 2 };
    await service.execute(input);
    await service.execute(input);
    assertEqual(callCount, 1, 'second identical query hits TTL cache');

    await service.execute({ ...input, engines: ['bing', 'startpage'] });
    assertEqual(callCount, 2, 'different engines bypass cache');

    // 失败结果不应被缓存：引擎第一次失败，第二次相同查询应重试
    let failCount = 0;
    const failingService = createSearchService({
        bing: async (query, limit) => {
            failCount += 1;
            throw new Error('temporary outage');
        }
    });
    const failingInput = { query: 'dont cache me', engines: ['bing'], limit: 1 };
    await failingService.execute(failingInput);
    await failingService.execute(failingInput);
    assertEqual(failCount, 6, 'failed search results are not cached (retried on next identical query)');

    // 直接验证缓存类（缓存结果数 >= limit 才命中）
    const cache = new SearchTtlCache(100);
    const cachedResults = Array.from({ length: 2 }, (_, i) => createResult('bing', i + 1));
    cache.set(input, { query: 'x', engines: ['bing'], totalResults: 2, results: cachedResults, partialFailures: [] });
    assert(cache.get(input) !== undefined, 'cache returns fresh entry when results >= limit');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(cache.get(input) === undefined, 'cache expires entry after TTL');

    console.log('✅ SearchTtlCache deduplicates requests and expires');
}

async function testSearchTtlCacheInsufficientResultsMiss(): Promise<void> {
    // 场景 1：requestedLimit 不足时应 miss。
    // normalizeLimitBucket: limit=7 和 limit=10 都归一化为 10（同一档位）。
    // limit=7 写入 → limit=8 miss（requestedLimit=7 < 8）
    let callCount = 0;
    const service = createSearchService({
        bing: async (query, limit) => {
            callCount += 1;
            const count = callCount === 1 ? 7 : 10;
            return Array.from({ length: count }, (_, index) => createResult('bing', index + 1));
        }
    });

    const r1 = await service.execute({ query: 'insufficient', engines: ['bing'], limit: 7 });
    assertEqual(r1.totalResults, 7, 'first call returns 7 results from engine');
    assertEqual(callCount, 1, 'first call invokes engine');

    const r2 = await service.execute({ query: 'insufficient', engines: ['bing'], limit: 6 });
    assertEqual(r2.totalResults, 6, 'limit=6 truncates from cached 7 results');
    assertEqual(callCount, 1, 'limit=6 still hits cache (requestedLimit=7 >= 6)');

    const r3 = await service.execute({ query: 'insufficient', engines: ['bing'], limit: 8 });
    assertEqual(callCount, 2, 'limit=8 misses cache (requestedLimit=7 < 8)');
    assertEqual(r3.totalResults, 8, 'limit=8 gets fresh results after cache miss');

    console.log('✅ SearchTtlCache misses when requestedLimit < input.limit');
}

async function testSearchTtlCacheColdQueryHitsCache(): Promise<void> {
    // 场景 2：冷门查询（真实结果 < limit）不应导致缓存失效。
    // 引擎恒返 3 条，limit=5 → requestedLimit=5 存入缓存。
    // 后续 limit=5 应命中（3 条就是该查询的完整结果），只有 limit=8 才 miss。
    let callCount = 0;
    const service = createSearchService({
        bing: async (query, limit) => {
            callCount += 1;
            return Array.from({ length: 3 }, (_, index) => createResult('bing', index + 1));
        }
    });

    // 第一次 limit=5，引擎返回 3 条 → 缓存（requestedLimit=5）
    const r1 = await service.execute({ query: 'cold query', engines: ['bing'], limit: 5 });
    assertEqual(r1.totalResults, 3, 'cold query returns 3 results from engine');
    assertEqual(callCount, 1, 'first call invokes engine');

    // 第二次 limit=5，命中缓存（requestedLimit=5 >= 5）
    const r2 = await service.execute({ query: 'cold query', engines: ['bing'], limit: 5 });
    assertEqual(r2.totalResults, 3, 'same limit=5 hits cache with 3 results');
    assertEqual(callCount, 1, 'same limit does not re-invoke engine');

    // limit=4 也命中（requestedLimit=5 >= 4）
    const r3 = await service.execute({ query: 'cold query', engines: ['bing'], limit: 4 });
    assertEqual(r3.totalResults, 3, 'limit=4 hits cache (requestedLimit=5 >= 4, 3 results returned as-is)');
    assertEqual(callCount, 1, 'limit=4 does not re-invoke engine');

    // limit=8 miss（requestedLimit=5 < 8）
    const r4 = await service.execute({ query: 'cold query', engines: ['bing'], limit: 8 });
    assertEqual(callCount, 2, 'limit=8 misses cache (requestedLimit=5 < 8)');

    console.log('✅ SearchTtlCache cold query does not thrash cache');
}

async function testSearchQueryTooLong(): Promise<void> {
    const service = createSearchService({
        bing: async (query, limit) => Array.from({ length: limit }, (_, i) => createResult('bing', i + 1))
    });

    let threw = false;
    try {
        await service.execute({ query: 'x'.repeat(501), engines: ['bing'], limit: 1 });
    } catch (error) {
        threw = error instanceof Error && error.message.includes('Query string too long');
    }
    assert(threw, 'query over 500 characters should be rejected');

    // 500 字符刚好通过
    const result = await service.execute({ query: 'x'.repeat(500), engines: ['bing'], limit: 1 });
    assertEqual(result.totalResults, 1, '500-character query is accepted');

    console.log('✅ search service rejects queries over 500 characters');
}

async function testSearchZeroQuotaEngines(): Promise<void> {
    // limit=1, 3 引擎 → 配额 [1,0,0]；后两个引擎虽配额为 0 但不应产生 partialFailures（它们"未被调用"）
    const called: string[] = [];
    const service = createSearchService({
        bing: async (query, limit) => { called.push(`bing:${limit}`); return [{ title: 'a', url: 'https://a.com', description: '', source: 'a.com', engine: 'bing' }]; },
        duckduckgo: async () => { called.push('duckduckgo'); return []; },
        startpage: async () => { called.push('startpage'); return []; }
    });

    const result = await service.execute({ query: 'q', engines: ['bing', 'duckduckgo', 'startpage'], limit: 1 });

    // 只有 bing 被调用（配额 1），duckduckgo/startpage 配额 0 不应被调用
    assertEqualArray(called, ['bing:1'], 'only engines with non-zero quota are invoked');
    // 未调用的引擎不应出现在 partialFailures（它们只是没被分配配额）
    assertEqual(result.partialFailures.length, 0, 'zero-quota engines are not reported as failures');

    // 相反：配额 >0 但返回空 → 应计入 partialFailures
    const result2 = await service.execute({ query: 'q2', engines: ['bing', 'duckduckgo'], limit: 3 });
    assertEqual(result2.partialFailures.length, 1, 'engine with quota but no results is reported');
    assertEqual(result2.partialFailures[0].engine, 'duckduckgo', 'empty-result engine is identified');

    console.log('✅ search service reports zero-quota engines distinctly from empty results');
}

async function testSearchServiceMinResultsCascade(): Promise<void> {
    const called: string[] = [];
    const engineMap: SearchEngineExecutorMap = {
        bing: async (query, limit) => {
            called.push(`bing:${limit}`);
            // bing 只返回 1 条（配额 3 却只有 1 条），迫使 minResults 触发级联
            return [createResult('bing', 1)];
        },
        startpage: async (query, limit) => {
            called.push(`startpage:${limit}`);
            throw new Error('startpage blocked');
        },
        duckduckgo: async (query, limit) => {
            called.push(`duckduckgo:${limit}`);
            return Array.from({ length: limit }, (_, index) => createResult('duckduckgo', index + 1));
        }
    };

    const service = createSearchService(engineMap);
    const result = await service.execute({
        query: 'cascade me',
        engines: ['bing', 'startpage'],
        limit: 5,
        minResults: 3
    });

    assert(result.totalResults >= 3, 'minResults cascade should fill up to at least 3 results');
    assert(result.cascadedEngines?.includes('duckduckgo'), 'cascade should record the compensating engine');
    assert(called.includes('duckduckgo:2'), 'cascade should run the compensating engine with the gap quota');
    assertEqual(result.partialFailures.length, 1, 'only the originally failed engine is a partial failure');
    assertEqual(result.partialFailures[0].engine, 'startpage', 'failed engine recorded');

    // minResults 默认（不传）= 0，不触发级联
    const noCascade = await service.execute({
        query: 'cascade me',
        engines: ['bing'],
        limit: 5
    });
    assert(!noCascade.cascadedEngines, 'no cascade when minResults is not set');

    console.log('✅ search service minResults cascade fills missing results with other engines');
}

async function testSearchServiceClearCache(): Promise<void> {
    let callCount = 0;
    const service = createSearchService({
        bing: async (query, limit) => {
            callCount += 1;
            return Array.from({ length: limit }, (_, index) => createResult('bing', index + 1));
        }
    });

    const input = { query: 'clear me', engines: ['bing'], limit: 2 };
    await service.execute(input);
    await service.execute(input);
    assertEqual(callCount, 1, 'first two identical queries share cache');

    service.clearCache();
    await service.execute(input);
    assertEqual(callCount, 2, 'after clearCache the same query re-executes');
    assertEqual(service.cacheSize, 1, 'cache repopulates after clear');

    console.log('✅ search service clearCache invalidates TTL cache');
}

async function testPartialFailuresCarryHint(): Promise<void> {
    const service = createSearchService({
        bing: async (query, limit) => {
            throw new Error('temporary outage');
        }
    });

    const result = await service.execute({ query: 'hint me', engines: ['bing'], limit: 1 });
    assertEqual(result.partialFailures.length, 1, 'one failure recorded');
    assert(
        result.partialFailures[0].message.includes('Hint:'),
        'failure message should carry an actionable hint for the LLM'
    );

    console.log('✅ partial failure messages carry actionable hints');
}

async function main(): Promise<void> {
    testNormalizeEngineName();
    testDistributeLimit();
    testResolveRequestedEngines();
    await testSearchServiceExecution();
    await testSearchServiceAutoModeUsesRuntimeDefault();
    await testSearchServiceValidation();
    testNormalizeResultUrl();
    testMergeSearchResultsDedupAndRank();
    await testSearchTtlCache();
    await testSearchTtlCacheInsufficientResultsMiss();
    await testSearchTtlCacheColdQueryHitsCache();
    await testSearchQueryTooLong();
    await testSearchZeroQuotaEngines();
    await testSearchServiceMinResultsCascade();
    await testSearchServiceClearCache();
    await testPartialFailuresCarryHint();
    console.log('\nCore search tests passed.');
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
