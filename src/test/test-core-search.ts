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

    // 直接验证缓存类
    const cache = new SearchTtlCache(100);
    cache.set(input, { query: 'x', engines: ['bing'], totalResults: 0, results: [], partialFailures: [] });
    assert(cache.get(input) !== undefined, 'cache returns fresh entry');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(cache.get(input) === undefined, 'cache expires entry after TTL');

    console.log('✅ SearchTtlCache deduplicates requests and expires');
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
    await testSearchZeroQuotaEngines();
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
