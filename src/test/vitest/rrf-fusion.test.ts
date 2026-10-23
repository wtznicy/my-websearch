import { afterEach, describe, expect, it } from 'vitest';
import { mergeSearchResults } from '../../core/search/mergeResults.js';
import { rankSearchResults } from '../../core/search/resultRanking.js';
import type { SearchResult } from '../../types.js';

/**
 * RRF 回归：默认（legacy）保持旧行为；SEARCH_FUSION=rrf 时按「各引擎内排名」融合，
 * 用来验证「两个引擎都排第 1」应压过「两个引擎都排第 3」，而 legacy 只看命中数。
 */
const item = (url: string, engine: string): SearchResult => ({
    title: `Title for ${url}`,
    url,
    description: 'useful description text',
    source: 'example.com',
    engine
});

const asResults = (engine: string, urls: string[]) => urls.map((url) => item(url, engine));

afterEach(() => {
    delete process.env.SEARCH_FUSION;
    delete process.env.SEARCH_FUSION_RRF_K;
});

describe('mergeSearchResults fusion modes', () => {
    it('legacy mode keeps the historical engine-hit ordering and adds no rrfScore', () => {
        const merged = mergeSearchResults([
            asResults('bing', ['https://a.com/1', 'https://a.com/2']),
            asResults('baidu', ['https://a.com/2', 'https://a.com/3'])
        ]);
        expect(merged[0]?.url).toBe('https://a.com/2');
        expect(merged[0]?.engineHits).toBe(2);
        expect(merged[0]?.rrfScore).toBeUndefined();
    });

    it('rrf mode prefers the result both engines ranked first over one both ranked third', () => {
        process.env.SEARCH_FUSION = 'rrf';
        process.env.SEARCH_FUSION_RRF_K = '20';
        const merged = mergeSearchResults([
            asResults('bing', ['https://a.com/1', 'https://a.com/x', 'https://a.com/late']),
            asResults('baidu', ['https://a.com/1', 'https://a.com/y', 'https://a.com/late'])
        ]);
        // /1 被两引擎都排第 1；/late 被两引擎都排第 3
        expect(merged[0]?.url).toBe('https://a.com/1');
        expect(merged[0]?.rrfScore).toBeGreaterThan(merged.find((r) => r.url === 'https://a.com/late')?.rrfScore ?? 0);
    });

    it('rrf mode is deterministic for equal scores (URL tie-break)', () => {
        process.env.SEARCH_FUSION = 'rrf';
        const run = () => mergeSearchResults([
            asResults('bing', ['https://b.com/x', 'https://a.com/x']),
            asResults('baidu', ['https://b.com/x', 'https://a.com/x'])
        ]).map((r) => r.url);
        expect(run()).toEqual(run());
    });
});

describe('rankSearchResults with RRF', () => {
    it('uses the RRF feature instead of position+consensus when enabled', () => {
        process.env.SEARCH_FUSION = 'rrf';
        const merged = mergeSearchResults([
            asResults('bing', ['https://a.com/1', 'https://a.com/2']),
            asResults('baidu', ['https://a.com/1', 'https://a.com/2'])
        ]);
        const ranked = rankSearchResults(merged, 'title for url');
        expect(ranked[0]?.url).toBe('https://a.com/1');
    });
});
