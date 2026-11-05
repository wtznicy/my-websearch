import { describe, it, expect } from 'vitest';
import {
    rankSearchResults,
    tokenizeForRanking,
    countUsableResults,
    hasFirstTokenDrift,
    computeVersionPathAdjustment,
    computeFreshnessAdjustment,
    computeTitleFocusPenalty
} from '../../core/search/resultRanking.js';
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

    it('should count full-page high-relevance results as usable even when core terms exceed rarityCap (df > sqrt(N))', () => {
        // 复现：baidu 返回 10 条高度相关的 MCP 教程结果，其中 9 条都含 model/context/protocol（df=9 > rarityCap=4），
        // 仅 2 条含"教程"（df=2 <= 4）。不能因为核心词出现太普遍就把其余 7 条判为不可用而误触发级联。
        const results = Array.from({ length: 10 }, (_, idx) => makeResult({
            title: idx < 2
                ? `Model Context Protocol 教程 第${idx + 1}篇`
                : idx < 9
                    ? `Model Context Protocol 实战指南 第${idx + 1}篇`
                    : '无关词条',
            url: `https://example.com/article-${idx + 1}`,
            description: idx < 9 ? '详解 model context protocol 架构与服务端实现' : '其他内容'
        }));
        expect(countUsableResults(results, 'Model Context Protocol 教程')).toBe(9);
    });

    it('should NOT count noise results when "model" has df=4 in 5 results or generic pages only hit 2 of 3-4 tokens', () => {
        // 负向边界 1：注释中警告的 "model 在 5 条里 df=4"（且 context 同样 df=4 > rarityCap=3，仅 protocol df=1 为区分词）：
        // 旧版 0.6 阈值（ceil(3*0.6)=2）会把 3 条只含 model+context 的噪声放行（返回 4）；
        // 收紧为 max(3, ceil(N*0.75))=3 后，只命中 2/3 词且不含区分词 protocol 的噪声被严格拦截（返回 1）。
        const modelNoiseResults = [
            makeResult({ title: 'Model Context Protocol 官方规范', url: 'https://modelcontextprotocol.io/spec', description: 'model context protocol' }),
            makeResult({ title: 'Data Model with Context in Go', url: 'https://a.com/go', description: 'model context usage' }),
            makeResult({ title: 'Domain Model Context Pattern', url: 'https://a.com/ddd', description: 'model context bounded' }),
            makeResult({ title: 'View Model Context Binding', url: 'https://a.com/mvvm', description: 'model context mvvm' }),
            makeResult({ title: '今日天气预报', url: 'https://a.com/weather', description: '晴转多云' })
        ];
        expect(countUsableResults(modelNoiseResults, 'model context protocol')).toBe(1);

        // 负向边界 2：query 为 "react hooks 性能优化"（分词：react / hooks / 性能 / 优化 等 ≥4 token），
        // 只讲 react + hooks 的泛化列表页（仅命中 2 个 token < highCoverageThreshold=3 且零区分词）不得计为可用
        const reactHooksNoiseResults = [
            makeResult({ title: 'React Hooks 性能优化完全指南', url: 'https://a.com/perf', description: 'react hooks 性能优化 useMemo useCallback' }),
            makeResult({ title: 'React Hooks 入门列表', url: 'https://a.com/list-1', description: 'react hooks useState useEffect 基础' }),
            makeResult({ title: 'React Hooks 常见 API 汇总', url: 'https://a.com/list-2', description: 'react hooks 列表' }),
            makeResult({ title: 'React Hooks 教程目录', url: 'https://a.com/list-3', description: 'react hooks 概览' }),
            makeResult({ title: 'Vue3 简介', url: 'https://a.com/vue', description: 'vue composition api' })
        ];
        expect(countUsableResults(reactHooksNoiseResults, 'react hooks 性能优化')).toBe(1);
    });

    it('should detect first-token drift when cn.bing only matches the first word of a multi-word query (P0-2)', () => {
        // 复现：cn.bing 搜 "model context protocol specification" 返回 10 条结果，
        // 其中 2 条含 model（df=2 <= sqrt(10)=4，旧逻辑会把 model 当成"稀有区分词"！），
        // 其余 8 条完全无关，且前 5 条对第 2 个词及之后的词（context/protocol/specification）命中数为 0
        const driftedResults = [
            makeResult({ title: 'Model Y 特斯拉中国', url: 'https://www.tesla.cn/modely', description: 'Tesla Model Y 电动 SUV' }),
            makeResult({ title: 'model（英语单词）_百度百科', url: 'https://baike.baidu.com/item/model', description: 'model 名词 模特 模型' }),
            makeResult({ title: '今日热搜榜单', url: 'https://example.com/hot-1', description: '新闻资讯' }),
            makeResult({ title: '天气预报查询', url: 'https://example.com/hot-2', description: '全国天气' }),
            makeResult({ title: '在线翻译工具', url: 'https://example.com/hot-3', description: '词典翻译' }),
            makeResult({ title: '股票行情中心', url: 'https://example.com/hot-4', description: '财经资讯' }),
            makeResult({ title: '旅游攻略大全', url: 'https://example.com/hot-5', description: '景点门票' }),
            makeResult({ title: '美食菜谱分享', url: 'https://example.com/hot-6', description: '家常菜谱' }),
            makeResult({ title: '体育赛事直播', url: 'https://example.com/hot-7', description: '足球篮球' }),
            makeResult({ title: '音乐排行榜', url: 'https://example.com/hot-8', description: '流行歌曲' })
        ];
        expect(hasFirstTokenDrift(driftedResults, 'model context protocol specification')).toBe(true);
        expect(countUsableResults(driftedResults, 'model context protocol specification')).toBe(0);
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

    it('should honor an internal rankBoost for exact matches', () => {
        const results = [
            makeResult({
                title: 'fbsamples/f8app',
                url: 'https://github.com/fbsamples/f8app',
                description: 'Source code of the official F8 app, powered by React Native and Facebook open source projects.'
            }),
            {
                ...makeResult({
                    title: 'react/react',
                    url: 'https://github.com/react/react',
                    description: 'The library for web and native user interfaces.'
                }),
                rankBoost: 100
            }
        ];

        const ranked = rankSearchResults(results, 'facebook/react');
        expect(ranked[0].title).toBe('react/react');
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

    describe('applyHostCap (Host Cap & Domain Diversity)', () => {
        it('should demote overflow results from the same root domain beyond cap=2 to the tail', () => {
            const results = [
                makeResult({ title: 'Juejin 1', url: 'https://juejin.cn/post/1', description: 'react tutorial' }),
                makeResult({ title: 'Juejin 2', url: 'https://juejin.cn/post/2', description: 'react tutorial' }),
                makeResult({ title: 'Juejin 3', url: 'https://juejin.cn/post/3', description: 'react tutorial' }),
                makeResult({ title: 'Juejin 4', url: 'https://juejin.cn/post/4', description: 'react tutorial' }),
                makeResult({ title: 'React Official', url: 'https://react.dev/learn', description: 'react tutorial official' }),
                makeResult({ title: 'Zhihu Post', url: 'https://zhuanlan.zhihu.com/p/1', description: 'react tutorial' })
            ];

            const ranked = rankSearchResults(results, 'react tutorial');
            const top4Urls = ranked.slice(0, 4).map((r) => r.url);
            expect(top4Urls).toContain('https://react.dev/learn');
            expect(top4Urls).toContain('https://zhuanlan.zhihu.com/p/1');
            expect(top4Urls.filter((url) => url.includes('juejin.cn')).length).toBe(2);
            expect(ranked.slice(4).map((r) => r.url)).toEqual([
                'https://juejin.cn/post/3',
                'https://juejin.cn/post/4'
            ]);
        });

        it('should allow Tier1 official documentation domains up to cap=3', () => {
            const results = [
                makeResult({ title: 'React Learn 1', url: 'https://react.dev/learn/1', description: 'react guide 1' }),
                makeResult({ title: 'React Learn 2', url: 'https://react.dev/learn/2', description: 'react guide 2' }),
                makeResult({ title: 'React Learn 3', url: 'https://react.dev/learn/3', description: 'react guide 3' }),
                makeResult({ title: 'React Learn 4', url: 'https://react.dev/learn/4', description: 'react guide 4' }),
                makeResult({ title: 'Other site', url: 'https://example.com/react', description: 'react guide' })
            ];

            const ranked = rankSearchResults(results, 'react guide');
            const top4Urls = ranked.slice(0, 4).map((r) => r.url);
            expect(top4Urls.filter((url) => url.includes('react.dev')).length).toBe(3);
            expect(top4Urls).toContain('https://example.com/react');
            expect(ranked[4].url).toBe('https://react.dev/learn/4');
        });
    });

    describe('P1-5: Relevance hard guard (zero core match demotion)', () => {
        it('should demote completely irrelevant results (e.g. bluetooth or ping test) to the very tail', () => {
            const results = [
                // Result 1: At position 0, but only hits generic word 'configuration' (Windows bluetooth)
                makeResult({
                    title: 'Windows 11 Bluetooth Adapter Configuration',
                    url: 'https://example.com/bt-config',
                    description: 'Wireless bluetooth adapter device configuration guide'
                }),
                // Result 2: Hits core entity 'vitest' and 'node'
                makeResult({
                    title: 'Vitest 5 Release Notes - Node.js 22 Support',
                    url: 'https://vitest.dev/blog/vitest-5',
                    description: 'Vitest 5 configuration and compatibility with Node.js 22'
                }),
                // Result 3: Another relevant result
                makeResult({
                    title: 'Configuring Vitest in Node.js Projects',
                    url: 'https://example.com/vitest-node',
                    description: 'Setup and configuration guide for Vitest with Node.js 22'
                })
            ];

            const ranked = rankSearchResults(results, 'Vitest 5 Node.js 22 configuration');
            // The Bluetooth result (even though it started at index 0 and matched 'configuration')
            // must be demoted to the tail because it has zero match on core tokens (vitest, node)
            expect(ranked[0].url).toBe('https://vitest.dev/blog/vitest-5');
            expect(ranked[1].url).toBe('https://example.com/vitest-node');
            expect(ranked[2].url).toBe('https://example.com/bt-config');
        });
    });

    // 注：共识因子（engineHits，权重 0.1）按设计无法翻转位置分（权重 0.4）——
    // 共识排序由 mergeSearchResults 层保证（按不同引擎命中数主导排序），此处不重复断言。

    describe('P2-7 & P2-8: Version path preference & Smooth freshness decay', () => {
        it('computeVersionPathAdjustment identifies latest vs legacy paths', () => {
            expect(computeVersionPathAdjustment('https://spec.modelcontextprotocol.io/latest/overview')).toBe(0.08);
            expect(computeVersionPathAdjustment('https://spec.modelcontextprotocol.io/draft/schema')).toBe(0.08);
            expect(computeVersionPathAdjustment('https://spec.modelcontextprotocol.io/v2/docs')).toBe(0.08);

            expect(computeVersionPathAdjustment('https://spec.modelcontextprotocol.io/legacy/overview')).toBe(-0.12);
            expect(computeVersionPathAdjustment('https://spec.modelcontextprotocol.io/archive/2023')).toBe(-0.12);
            expect(computeVersionPathAdjustment('https://spec.modelcontextprotocol.io/v0.1/specification')).toBe(-0.12);

            expect(computeVersionPathAdjustment('https://example.com/normal/page')).toBe(0);
        });

        it('re-orders outdated specification inverted results to prioritize latest spec', () => {
            const results = [
                // Old spec was returned first by search engine
                makeResult({
                    title: 'Model Context Protocol Specification v0.1',
                    url: 'https://spec.modelcontextprotocol.io/v0.1/specification',
                    description: 'Draft legacy specification for Model Context Protocol version 0.1'
                }),
                // Latest spec was returned second
                makeResult({
                    title: 'Model Context Protocol Specification Latest',
                    url: 'https://spec.modelcontextprotocol.io/latest/specification',
                    description: 'Official latest specification for Model Context Protocol'
                })
            ];

            const ranked = rankSearchResults(results, 'MCP specification');
            expect(ranked[0].url).toBe('https://spec.modelcontextprotocol.io/latest/specification');
            expect(ranked[1].url).toBe('https://spec.modelcontextprotocol.io/v0.1/specification');
        });

        it('computeFreshnessAdjustment decays smoothly without harsh hard drop', () => {
            const currentYear = new Date().getFullYear();
            expect(computeFreshnessAdjustment(`${currentYear}-01-01`, true)).toBe(0.12);
            expect(computeFreshnessAdjustment(`${currentYear - 1}-01-01`, true)).toBe(0.06);
            expect(computeFreshnessAdjustment(`${currentYear - 2}-01-01`, true)).toBe(0);
            expect(computeFreshnessAdjustment(`${currentYear - 4}-01-01`, true)).toBeLessThan(0);
            // No date -> 0 (retained softly, not penalized)
            expect(computeFreshnessAdjustment(undefined, true)).toBe(0);
            // No freshness query -> 0
            expect(computeFreshnessAdjustment(`${currentYear}-01-01`, false)).toBe(0);
        });
        it('supports date-shaped specification paths (e.g. 2026 vs 2025)', () => {
            expect(computeVersionPathAdjustment('https://spec.modelcontextprotocol.io/specification/2026-07-28')).toBe(0.18);
            expect(computeVersionPathAdjustment('https://spec.modelcontextprotocol.io/specification/2025-03-26')).toBe(0.04);
            expect(computeVersionPathAdjustment('https://spec.modelcontextprotocol.io/specification/2023-01-01')).toBeLessThan(0);

            const results = [
                makeResult({
                    title: 'MCP Specification 2025-03-26',
                    url: 'https://spec.modelcontextprotocol.io/specification/2025-03-26',
                    description: 'Specification 2025 version'
                }),
                makeResult({
                    title: 'MCP Specification 2026-07-28',
                    url: 'https://spec.modelcontextprotocol.io/specification/2026-07-28',
                    description: 'Specification 2026 version'
                })
            ];
            const ranked = rankSearchResults(results, 'MCP specification');
            expect(ranked[0].url).toBe('https://spec.modelcontextprotocol.io/specification/2026-07-28');
        });

        it('strictly demotes results that only match generic words like 最新/版本 (e.g. LetPub)', () => {
            const results = [
                makeResult({
                    title: 'LetPub 期刊查询 - 最新影响因子与分区版本发布',
                    url: 'https://example.com/letpub',
                    description: 'LetPub 整理最新中科院期刊分区与版本更新说明'
                }),
                makeResult({
                    title: 'Node.js 官方发布说明 - Node.js 22 LTS',
                    url: 'https://nodejs.org/en/blog/release/v22',
                    description: 'Node.js 22 is the latest active LTS version'
                })
            ];

            const ranked = rankSearchResults(results, 'Node.js 最新 LTS 版本');
            expect(ranked[0].url).toBe('https://nodejs.org/en/blog/release/v22');
            expect(ranked[1].url).toBe('https://example.com/letpub');
        });

        it('prioritizes title hits over body-only keyword drops (e.g. Vitest doc vs React 18 news)', () => {
            const results = [
                makeResult({
                    title: 'React 18 / Electron 18 正式发布',
                    url: 'https://example.com/react-18',
                    description: '前端技术周刊：React 18 正式发布，文章末尾提到推荐搭配 Vitest 做单元测试。'
                }),
                makeResult({
                    title: 'Vitest 官方中文文档 - 下一代前端测试框架',
                    url: 'https://cn.vitest.dev/guide/',
                    description: 'Vitest 中文文档与完整指南教程。'
                })
            ];

            const ranked = rankSearchResults(results, 'Vitest 中文文档');
            expect(ranked[0].url).toBe('https://cn.vitest.dev/guide/');
        });

        it('correctly counts usable results for Chinese tech queries without harsh misclassification', () => {
            const results = [
                makeResult({ title: 'MCP 协议详解', description: 'Model Context Protocol 规范介绍与教程' }),
                makeResult({ title: '深入浅出 MCP 协议', description: 'MCP 协议架构与官方文档阅读' }),
                makeResult({ title: '华为开发者：MCP 协议实践指南', description: '基于 MCP 协议构建 Agent' }),
                makeResult({ title: '知乎专栏：MCP 协议与大模型应用', description: '文档解读与实现' }),
                makeResult({ title: 'CSDN：MCP 协议从入门到精通', description: '官方规范中文翻译' }),
                makeResult({ title: '无关的随机生活杂记', description: '今天天气真好，出去散步。' })
            ];

            const usable = countUsableResults(results, 'MCP 协议 官方文档');
            expect(usable).toBe(5);
        });
        it('penalizes newsletter and roundup aggregators where core entity is buried at the end', () => {
            const core = ['vitest'];
            // 典型蹭热词周刊：标题主体是 React 18，Vitest 仅在末尾列举
            const aggregatorTitle = 'React 18 / Electron 18 正式发布，汇总 Vue 3 与 Vitest 更新';
            expect(computeTitleFocusPenalty(aggregatorTitle, core)).toBe(-0.30);

            // 真正的官方或专注于 Vitest 的标题不降权
            const officialTitle = 'GitHub - vitest-dev/docs-cn: Vitest 中文文档';
            expect(computeTitleFocusPenalty(officialTitle, core)).toBe(0);

            const guideTitle = '快速起步 | 指南 | Vitest';
            expect(computeTitleFocusPenalty(guideTitle, core)).toBe(0);

            const directTitle = 'Vitest 入门教程与配置指南';
            expect(computeTitleFocusPenalty(directTitle, core)).toBe(0);
        });

        it('deprioritizes aggregated news below specialized guides in rankSearchResults', () => {
            const results = [
                // 位置排第 1，但标题是周刊末尾蹭词
                makeResult({
                    title: 'React 18 正式发布，汇总 Electron 18 与 Vitest',
                    url: 'https://blog.csdn.net/news/article/1',
                    description: '本期周刊汇总多个库的发布动态，包含 React 18、Electron 18 以及测试框架 Vitest。'
                }),
                // 位置排第 2，但标题和内容高度聚焦 Vitest
                makeResult({
                    title: 'Vitest 快速起步与官方配置指南',
                    url: 'https://cn.vitest.dev/guide/',
                    description: 'Vitest 是下一代由 Vite 驱动的超快单元测试框架。'
                })
            ];

            const ranked = rankSearchResults(results, 'Vitest 中文文档');
            // 聚焦的专门指南应成功反超蹭词周刊
            expect(ranked[0].url).toBe('https://cn.vitest.dev/guide/');
        });

        it('does NOT trigger Chinese entity fast-path when query consists solely of generic terms', () => {
            const results = [
                makeResult({ title: '官方公告', description: '关于近期系统维护的官方说明' }),
                makeResult({ title: '文档中心', description: '各类服务文档汇总' }),
                makeResult({ title: '天气预报', description: '北京今天晴朗' })
            ];
            // 纯泛化词查询（无具体技术实体），必须严格要求区分词/高覆盖率，不得靠通用词直通
            const usable = countUsableResults(results, '官方 文档 教程 指南');
            expect(usable).toBe(0);
        });
    });
});
