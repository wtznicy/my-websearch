import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildDoctorReport, formatDoctorHumanReadable } from '../../cli/doctor.js';
import { tripEngineCircuit, resetEngineCircuits } from '../../core/search/engineCircuitBreaker.js';
import { metrics } from '../../core/metrics.js';
import { createConfig } from '../../config.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';

describe('P2-12: doctor --network 指标扩展', () => {
    const runtime = createMyWebSearchRuntime({
        config: createConfig({
            DEFAULT_SEARCH_ENGINE: 'bing'
        })
    });

    beforeEach(() => {
        resetEngineCircuits();
        process.env.METRICS_ENABLED = 'true';
        metrics.resetMetrics();
    });

    afterEach(() => {
        resetEngineCircuits();
        metrics.resetMetrics();
    });

    it('DoctorReport JSON 与人类可读文本应包含 cacheStats 命中率指标', async () => {
        // 模拟记录搜索缓存命中/未命中
        metrics.recordCacheHit();
        metrics.recordCacheHit();
        metrics.recordCacheMiss(); // 2 hits, 1 miss -> 67%

        // 模拟记录页面抓取缓存
        metrics.recordFetchCacheHit();
        metrics.recordFetchCacheMiss(); // 1 hit, 1 miss -> 50%

        const report = await buildDoctorReport(runtime, {
            version: '1.4.2-test',
            network: true
        });

        // JSON 断言
        expect(report.cacheStats).toBeDefined();
        expect(report.cacheStats?.search.hits).toBe(2);
        expect(report.cacheStats?.search.misses).toBe(1);
        expect(report.cacheStats?.search.hitRate).toBe(67);
        expect(report.cacheStats?.fetch.hits).toBe(1);
        expect(report.cacheStats?.fetch.misses).toBe(1);
        expect(report.cacheStats?.fetch.hitRate).toBe(50);

        // 文本断言
        const text = formatDoctorHumanReadable(report);
        expect(text).toContain('Cache hit rate:');
        expect(text).toContain('Search cache:    67% (2 hits, 1 misses)');
        expect(text).toContain('Fetch pageCache: 50% (1 hits, 1 misses)');
    });

    it('DoctorReport 应包含引擎熔断剩余时间 circuitRemainingMs', async () => {
        tripEngineCircuit('bing');

        const report = await buildDoctorReport(runtime, {
            version: '1.4.2-test',
            network: false
        });

        const bingStatus = report.engines.find((e) => e.engine === 'bing');
        expect(bingStatus).toBeDefined();
        expect(bingStatus?.circuitOpen).toBe(true);
        expect(bingStatus?.circuitRemainingMs).toBeGreaterThan(0);

        const text = formatDoctorHumanReadable(report);
        expect(text).toMatch(/bing\s+status=circuit_open.*circuit=\d+s/);
    });

    it('DoctorReport 引擎状态与文本应包含来自 metrics 的 P50 与 P95 耗时统计', async () => {
        const now = Date.now();
        // 模拟若干次 bing 搜索耗时样本: 100ms, 200ms, 300ms, 400ms, 500ms
        metrics.recordEngineSearch('bing', 100, true, now);
        metrics.recordEngineSearch('bing', 200, true, now);
        metrics.recordEngineSearch('bing', 300, true, now);
        metrics.recordEngineSearch('bing', 400, true, now);
        metrics.recordEngineSearch('bing', 500, true, now);

        const report = await buildDoctorReport(runtime, {
            version: '1.4.2-test',
            network: false
        });

        const bingStatus = report.engines.find((e) => e.engine === 'bing');
        expect(bingStatus).toBeDefined();
        expect(bingStatus?.p50Ms).toBe(300);
        expect(bingStatus?.p95Ms).toBe(500);

        const text = formatDoctorHumanReadable(report);
        expect(text).toContain('p50=300ms p95=500ms');
    });
});
