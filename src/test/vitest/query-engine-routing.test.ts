import { describe, it, expect, afterEach } from 'vitest';
import { pickDefaultEngineForQuery, pickDefaultEnginesForQuery } from '../../core/search/queryEngineRouting.js';
import { metrics } from '../../core/metrics.js';
import { resetEngineCircuits, tripEngineCircuit } from '../../core/search/engineCircuitBreaker.js';

describe('pickDefaultEngineForQuery', () => {
    const origEn = process.env.AUTO_ROUTE_EN_ENGINES;
    const origZh = process.env.AUTO_ROUTE_ZH_ENGINES;
    const origExa = process.env.EXA_API_KEY;

    afterEach(() => {
        if (origEn === undefined) delete process.env.AUTO_ROUTE_EN_ENGINES;
        else process.env.AUTO_ROUTE_EN_ENGINES = origEn;
        if (origZh === undefined) delete process.env.AUTO_ROUTE_ZH_ENGINES;
        else process.env.AUTO_ROUTE_ZH_ENGINES = origZh;
        if (origExa === undefined) delete process.env.EXA_API_KEY;
        else process.env.EXA_API_KEY = origExa;
        metrics.resetMetrics();
        resetEngineCircuits();
    });

    it('should keep the configured engine when not "auto"', () => {
        expect(pickDefaultEngineForQuery('任何查询', 'sogou')).toBe('sogou');
        expect(pickDefaultEngineForQuery('hello world', 'bing')).toBe('bing');
    });

    it('should route Chinese natural-language queries to baidu in auto mode', () => {
        expect(pickDefaultEngineForQuery('量化宽松政策是什么', 'auto')).toBe('baidu');
        expect(pickDefaultEngineForQuery('最近有什么好看的电影', 'auto')).toBe('baidu');
        expect(pickDefaultEngineForQuery('红烧肉的做法', 'auto')).toBe('baidu');
    });

    it('should route English queries to bing in auto mode', () => {
        expect(pickDefaultEngineForQuery('hello world', 'auto')).toBe('bing');
        expect(pickDefaultEngineForQuery('best javascript framework', 'auto')).toBe('bing');
    });

    it('should return an engine GROUP for English queries (bing + duckduckgo fallback)', () => {
        // 英文不再押注单点：默认并列 bing + duckduckgo
        expect(pickDefaultEnginesForQuery('github-mcp-server v1.12 release notes', 'auto'))
            .toEqual(['bing', 'duckduckgo']);
        expect(pickDefaultEnginesForQuery('中文查询', 'auto')).toEqual(['baidu', 'sogou']);
        // 显式默认引擎不受影响
        expect(pickDefaultEnginesForQuery('anything', 'sogou')).toEqual(['sogou']);
        // env 覆盖
        expect(pickDefaultEnginesForQuery('english query', 'auto', { en: ['bing', 'startpage'] }))
            .toEqual(['bing', 'startpage']);
    });

    it('should honor AUTO_ROUTE_EN_ENGINES and AUTO_ROUTE_ZH_ENGINES env overrides (P1-7)', () => {
        process.env.AUTO_ROUTE_EN_ENGINES = 'bing,exa';
        process.env.AUTO_ROUTE_ZH_ENGINES = 'baidu,csdn,juejin';
        expect(pickDefaultEnginesForQuery('model context protocol', 'auto')).toEqual(['bing', 'exa']);
        expect(pickDefaultEnginesForQuery('中文技术查询', 'auto')).toEqual(['baidu', 'csdn', 'juejin']);
    });

    it('should filter out unhealthy primary engines and substitute from fallback pool (P1-6)', () => {
        process.env.EXA_API_KEY = 'test-exa-key';
        // 模拟 duckduckgo 近期连续 2 次超时失败（successRate = 0 < 50%）
        metrics.recordEngineSearch('duckduckgo', 10000, false);
        metrics.recordEngineSearch('duckduckgo', 10000, false);
        expect(pickDefaultEnginesForQuery('rust tokio select', 'auto')).toEqual(['bing', 'exa']);

        // 中文主引擎 sogou 熔断时，用**同类通用引擎**替补（bing），而不是 CSDN/掘金这类垂直站：
        // 垂直站无法回答「杭州落户政策」「今天天气」这类通用查询（P1-6 修正）
        tripEngineCircuit('sogou');
        const zhFallback = pickDefaultEnginesForQuery('异步运行时原理对比', 'auto');
        expect(zhFallback).toEqual(['baidu', 'bing']);
        expect(zhFallback).not.toContain('csdn');
        expect(zhFallback).not.toContain('juejin');
    });

    it('should route mixed Chinese-English technical queries to [bing, juejin, baidu]', () => {
        expect(pickDefaultEnginesForQuery('Next.js 15 Hydration failed 怎么解决', 'auto'))
            .toEqual(['bing', 'juejin', 'baidu']);
        expect(pickDefaultEnginesForQuery('TypeScript satisfies 用法', 'auto'))
            .toEqual(['bing', 'juejin', 'baidu']);
        expect(pickDefaultEnginesForQuery('rust tokio 死锁排查', 'auto'))
            .toEqual(['bing', 'juejin', 'baidu']);
        expect(pickDefaultEnginesForQuery('vue3 响应式原理', 'auto'))
            .toEqual(['bing', 'juejin', 'baidu']);
    });

    it('should route pure Chinese general queries to [baidu, sogou]', () => {
        expect(pickDefaultEnginesForQuery('量化宽松政策是什么', 'auto'))
            .toEqual(['baidu', 'sogou']);
        expect(pickDefaultEnginesForQuery('红烧肉的做法', 'auto'))
            .toEqual(['baidu', 'sogou']);
    });

    it('should route a single CJK char (likely noise) to bing', () => {
        expect(pickDefaultEngineForQuery('react tutorial 中', 'auto')).toBe('bing');
    });

    it('should fall back to bing for empty queries', () => {
        expect(pickDefaultEngineForQuery('', 'auto')).toBe('bing');
        expect(pickDefaultEngineForQuery('   ', 'auto')).toBe('bing');
    });
});
