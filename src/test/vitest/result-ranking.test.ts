import { describe, it, expect } from 'vitest';
import { rankSearchResults, tokenizeForRanking, countUsableResults } from '../../core/search/resultRanking.js';
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

describe('countUsableResults (rare-term coverage)', () => {
    it('should exclude semantic-drift results that only hit common query words', () => {
        // 复现：query 的稀有词是 context/protocol/specification，而噪声只命中通用词 model
        const results = [
            makeResult({ title: 'Model（英语单词）', url: 'https://baike.baidu.com/item/model', description: 'model 的翻译' }),
            makeResult({ title: 'Model Y 特斯拉', url: 'https://tesla.cn/model-y', description: '电动 SUV' }),
            makeResult({ title: 'Model 3', url: 'https://tesla.cn/model-3', description: '电动轿车' }),
            makeResult({ title: 'Model Context Protocol', url: 'https://modelcontextprotocol.io/spec', description: 'protocol specification for context' })
        ];
        // 只有最后一条命中稀有词
        expect(countUsableResults(results, 'model context protocol specification')).toBe(1);
    });

    it('should exclude site entry pages for non-navigational queries', () => {
        const results = [
            makeResult({ title: 'context protocol', url: 'https://example.com/', description: 'context protocol overview' }),
            makeResult({ title: 'context protocol guide', url: 'https://example.com/guide', description: 'context protocol guide' })
        ];
        expect(countUsableResults(results, 'context protocol')).toBe(1);
    });

    it('should still count matches for a single-token query where all results share the token', () => {
        const results = [
            makeResult({ title: 'React docs', url: 'https://react.dev/learn', description: 'react hooks' }),
            makeResult({ title: 'Vue docs', url: 'https://vuejs.org/guide', description: 'vue guide' })
        ];
        // query 只有 react：命中该词的计入，未命中的不计
        expect(countUsableResults(results, 'react')).toBe(1);
    });

    it('should NOT let a pool that exactly fills minResults mask semantic drift (N=5, 3 share only a common term)', () => {
        // 回归用例（池子刚好 5 条，此前判据失效）：区分词在池内 df=2，
        // 旧口径 floor(N/2)=2 把 2<2 判为"不稀有"→ 回退"命中任一 token" → 噪声算可用
        const results = [
            makeResult({ title: 'Specification - Model Context Protocol', url: 'https://modelcontextprotocol.io/a', description: 'context protocol spec' }),
            makeResult({ title: 'Specification - MCP', url: 'https://modelcontextprotocol.io/b', description: 'context protocol' }),
            makeResult({ title: 'Model（英语单词）', url: 'https://baike.baidu.com/item/model', description: 'model 的翻译' }),
            makeResult({ title: 'Model Y 特斯拉', url: 'https://tesla.cn/model-y', description: 'model 电动 SUV' }),
            makeResult({ title: 'model是什么意思', url: 'https://iciba.com/model', description: 'model 释义' })
        ];
        // "model" df=5=N（无区分度，剔除）；context/protocol df=2（区分性）：
        // 只有前两条命中 → usable=2
        expect(countUsableResults(results, 'model context protocol specification')).toBe(2);
    });

    it('should require at least 2 token hits in the all-common-terms fallback', () => {
        const results = [
            makeResult({ title: 'react hooks guide', url: 'https://a.com/1', description: 'hooks tutorial' }),
            makeResult({ title: 'react intro', url: 'https://a.com/2', description: 'intro' })
        ];
        // query 两词都出现在两条结果里（df=N，无区分词）→ 回退要求命中 ≥2 个词
        expect(countUsableResults(results, 'react hooks')).toBe(1);
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

    it('should demote site entry pages for non-navigational queries', () => {
        const results = [
            makeResult({ title: 'GitHub', url: 'https://github.com/', description: 'github' }),
            makeResult({ title: 'Sign in', url: 'https://github.com/login', description: 'login' }),
            makeResult({ title: 'Release v1.12.0', url: 'https://github.com/wtznicy/github-mcp-server/releases/tag/v1.12.0', description: 'release notes for v1.12.0' })
        ];
        const ranked = rankSearchResults(results, 'github-mcp-server v1.12 release notes');
        // 真实 release 页应排到入口页之前
        expect(ranked[0].url).toContain('/releases/tag/');
    });

    it('should NOT penalize entry pages for navigational queries', () => {
        const results = [
            makeResult({ title: 'GitHub', url: 'https://github.com/', description: 'github official' }),
            makeResult({ title: 'some repo', url: 'https://github.com/wtznicy/my-websearch', description: 'repo page' })
        ];
        const ranked = rankSearchResults(results, 'github.com');
        // 导航类查询（域名）下首页不被惩罚，保持原序
        expect(ranked[0].url).toBe('https://github.com/');
    });

    // 注：共识因子（engineHits，权重 0.1）按设计无法翻转位置分（权重 0.4）——
    // 共识排序由 mergeSearchResults 层保证（按不同引擎命中数主导排序），此处不重复断言。

});
