import { describe, it, expect } from 'vitest';
import { rankSearchResults, tokenizeForRanking } from '../../core/search/resultRanking.js';
import type { SearchResult } from '../../types.js';

function makeResult(overrides: Partial<SearchResult>): SearchResult {
    return {
        title: 'title',
        url: 'https://example.com/page',
        description: 'description',
        source: 'example.com',
        engine: 'bing',
        ...overrides
    };
}

describe('tokenizeForRanking', () => {
    it('should tokenize latin words and CJK bigrams', () => {
        const tokens = tokenizeForRanking('React 教程 hooks');
        expect(tokens).toContain('react');
        expect(tokens).toContain('hooks');
        expect(tokens).toContain('教程');
    });
});

describe('rankSearchResults', () => {
    it('should promote a clearly more relevant result, but keep single/empty cases stable', () => {
        const results = [
            makeResult({ title: '无关的营销页面', url: 'https://spam.example.com/1', description: '优惠券 下载 安装' }),
            makeResult({ title: 'Python 教程入门指南', url: 'https://example.com/py', description: 'python 教程 基础 语法' })
        ];
        const ranked = rankSearchResults(results, 'python 教程');
        expect(ranked[0].title).toBe('Python 教程入门指南');
    });

    it('should prefer authority domains when relevance is comparable', () => {
        const results = [
            makeResult({ title: 'react docs', url: 'https://mirror-random-site.com/react', description: 'react docs' }),
            makeResult({ title: 'react docs', url: 'https://github.com/facebook/react', description: 'react docs' })
        ];
        const ranked = rankSearchResults(results, 'react docs');
        expect(ranked[0].url).toContain('github.com');
    });

    it('should keep original order for empty query', () => {
        const results = [
            makeResult({ title: 'A', url: 'https://a.com/1' }),
            makeResult({ title: 'B', url: 'https://b.com/1' })
        ];
        const ranked = rankSearchResults(results, '');
        expect(ranked.map((r) => r.title)).toEqual(['A', 'B']);
    });

    it('should not mutate results for single-item arrays', () => {
        const single = [makeResult({ title: 'Only' })];
        expect(rankSearchResults(single, 'anything')).toBe(single);
    });

    // 注：共识因子（engineHits，权重 0.1）按设计无法翻转位置分（权重 0.4）——
    // 共识排序由 mergeSearchResults 层保证（按不同引擎命中数主导排序），此处不重复断言。

});
