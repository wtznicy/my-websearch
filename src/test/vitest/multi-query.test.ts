import { describe, it, expect } from 'vitest';
import { mergeMultiQueryResults, mergeEngineMetricsAcrossQueries } from '../../core/search/multiQuery.js';
import type { SearchResult } from '../../types.js';

function makeResult(url: string, title: string = url): SearchResult {
    return { title, url, description: 'desc', source: 'example.com', engine: 'bing' };
}

describe('mergeMultiQueryResults (fair per-query quota)', () => {
    it('should not let a high-yield query starve others (repro: 5 vs 2, limit 6)', () => {
        const englishQueryResults = [1, 2, 3, 4, 5].map((i) => makeResult(`https://bing-${i}.com/a`));
        const chineseQueryResults = [makeResult('https://baidu-1.com/a'), makeResult('https://baidu-2.com/a')];

        const { results } = mergeMultiQueryResults([englishQueryResults, chineseQueryResults], 6);

        expect(results).toHaveLength(6);
        // 中文 query 的两条必须都出现（此前会被挤掉）
        expect(results.filter((r) => r.url.includes('baidu-'))).toHaveLength(2);
    });

    it('should keep a representative of every query even with a tight limit', () => {
        const many = [1, 2, 3, 4, 5].map((i) => makeResult(`https://a-${i}.com/x`));
        const one = [makeResult('https://b-1.com/x')];

        const { results } = mergeMultiQueryResults([many, one], 3);

        expect(results).toHaveLength(3);
        expect(results.some((r) => r.url.includes('b-1.com'))).toBe(true);
    });

    it('should dedupe by URL across queries', () => {
        const first = [makeResult('https://same.com/page'), makeResult('https://a.com/1')];
        const second = [makeResult('https://same.com/page?utm_source=x'), makeResult('https://b.com/1')];

        const { results } = mergeMultiQueryResults([first, second], 10);

        // same.com 的带跟踪参数版本与干净版本视为同一 URL（normalize 去 utm）
        expect(results.filter((r) => r.url.includes('same.com'))).toHaveLength(1);
        expect(results).toHaveLength(3);
    });

    it('should degrade to dedupe+truncate for a single query', () => {
        const single = [makeResult('https://a.com/1'), makeResult('https://a.com/1'), makeResult('https://a.com/2')];
        const { results } = mergeMultiQueryResults([single], 5);
        expect(results.map((r) => r.url)).toEqual(['https://a.com/1', 'https://a.com/2']);
    });
});

describe('mergeEngineMetricsAcrossQueries', () => {
    it('should aggregate metrics by engine across queries', () => {
        const merged = mergeEngineMetricsAcrossQueries([
            [{ engine: 'bing', ms: 100, count: 5 }],
            [{ engine: 'bing', ms: 50, count: 3 }, { engine: 'baidu', ms: 200, count: 4 }]
        ]);

        const bing = merged.find((m) => m.engine === 'bing');
        expect(bing).toMatchObject({ ms: 150, count: 8 });
        expect(merged.find((m) => m.engine === 'baidu')).toMatchObject({ ms: 200, count: 4 });
    });

    it('should keep the first non-empty error per engine', () => {
        const merged = mergeEngineMetricsAcrossQueries([
            [{ engine: 'brave', ms: 10, count: 0, error: '429' }],
            [{ engine: 'brave', ms: 20, count: 0, error: 'timeout' }]
        ]);
        expect(merged[0]).toMatchObject({ engine: 'brave', ms: 30, count: 0, error: '429' });
    });
});
