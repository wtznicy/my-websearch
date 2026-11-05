import { describe, it, expect } from 'vitest';
import {
    hasOfficialIntent,
    matchOfficialEntity,
    injectOfficialRecallIfNeeded
} from '../../core/search/officialRecall.js';
import { rankSearchResults } from '../../core/search/resultRanking.js';
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

describe('officialRecall', () => {
    describe('hasOfficialIntent', () => {
        it('identifies official and specification intent keywords', () => {
            expect(hasOfficialIntent('MCP 协议 官方文档')).toBe(true);
            expect(hasOfficialIntent('PostgreSQL 官网')).toBe(true);
            expect(hasOfficialIntent('OAuth 2.1 RFC specification')).toBe(true);
            expect(hasOfficialIntent('Vitest official docs')).toBe(true);
        });

        it('does NOT trigger for standard queries without official intent', () => {
            expect(hasOfficialIntent('Docker 无法拉取镜像 connection refused')).toBe(false);
            expect(hasOfficialIntent('React 性能优化实战')).toBe(false);
            expect(hasOfficialIntent('Node.js 安装包下载')).toBe(false);
        });
    });

    describe('matchOfficialEntity', () => {
        it('matches canonical entities like MCP, Vitest, Node.js', () => {
            expect(matchOfficialEntity('MCP 协议 官方文档')?.id).toBe('mcp');
            expect(matchOfficialEntity('Vitest 中文文档')?.id).toBe('vitest');
            expect(matchOfficialEntity('Node.js 最新 LTS 版本')?.id).toBe('nodejs');
            expect(matchOfficialEntity('PostgreSQL 官网')?.id).toBe('postgresql');
        });

        it('returns undefined for unknown entities', () => {
            expect(matchOfficialEntity('未知框架 官方文档')).toBeUndefined();
        });
    });

    describe('injectOfficialRecallIfNeeded', () => {
        it('does NOT inject when upstream engine has already recalled official domain', () => {
            const results = [
                makeResult({
                    title: 'Vitest 5.0 is out! | Vitest',
                    url: 'https://vitest.dev/blog/vitest-5.html'
                }),
                makeResult({
                    title: 'CSDN 教程',
                    url: 'https://blog.csdn.net/user/123'
                })
            ];

            const injected = injectOfficialRecallIfNeeded(results, 'Vitest official docs');
            expect(injected.length).toBe(2);
            expect(injected).toBe(results); // 引用不变
        });

        it('injects official specification entry when upstream engine omits official domain', () => {
            // 典型场景：国内搜索引擎由于索引偏好，前排全是知乎与社区博客，漏掉了 modelcontextprotocol.io
            const results = [
                makeResult({
                    title: '知乎专栏：深入理解 MCP 协议',
                    url: 'https://zhuanlan.zhihu.com/p/123456'
                }),
                makeResult({
                    title: '华为开发者：MCP 实战',
                    url: 'https://developer.huawei.com/forum/123'
                })
            ];

            const injected = injectOfficialRecallIfNeeded(results, 'MCP 协议 官方文档');
            expect(injected.length).toBe(3);
            expect(injected[0].url).toBe('https://modelcontextprotocol.io/');
            expect(injected[0].source).toBe('official');

            // 经过统一排序后，官方文档应当稳居前排
            const ranked = rankSearchResults(injected, 'MCP 协议 官方文档');
            expect(ranked[0].url).toBe('https://modelcontextprotocol.io/');
        });

        it('selects localized zhUrl for Chinese queries when available', () => {
            const results = [
                makeResult({
                    title: 'CSDN 教程',
                    url: 'https://blog.csdn.net/user/123'
                })
            ];

            const injected = injectOfficialRecallIfNeeded(results, 'Vitest 官方文档');
            expect(injected[0].url).toBe('https://cn.vitest.dev/');
        });
    });
});
