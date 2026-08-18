import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metrics } from '../../core/metrics.js';

describe('MetricsCollector', () => {
    beforeEach(() => {
        metrics.resetMetrics();
        // 默认禁用指标收集，测试中手动启用
        vi.stubEnv('METRICS_ENABLED', 'true');
        vi.stubEnv('SECURITY_AUDIT', 'true');
        vi.stubEnv('LOG_LEVEL', 'quiet');
    });

    describe('engine metrics', () => {
        it('should record engine search results', () => {
            metrics.recordEngineSearch('bing', 100, true);
            metrics.recordEngineSearch('bing', 200, false);
            metrics.recordEngineSearch('baidu', 150, true);

            const result = metrics.getMetrics();
            expect(result.engines.bing).toEqual({
                total: 2,
                success: 1,
                failure: 1,
                avgDurationMs: 150
            });
            expect(result.engines.baidu).toEqual({
                total: 1,
                success: 1,
                failure: 0,
                avgDurationMs: 150
            });
        });

        it('should not record when metrics disabled', () => {
            vi.stubEnv('METRICS_ENABLED', 'false');
            metrics.recordEngineSearch('bing', 100, true);

            const result = metrics.getMetrics();
            expect(result.engines.bing).toBeUndefined();
        });
    });

    describe('cache metrics', () => {
        it('should record cache hits and misses', () => {
            metrics.recordCacheHit();
            metrics.recordCacheHit();
            metrics.recordCacheMiss();

            const result = metrics.getMetrics();
            expect(result.cache).toEqual({
                hits: 2,
                misses: 1,
                hitRate: 67 // Math.round(2/3 * 100)
            });
        });

        it('should return 0 hit rate when no cache events', () => {
            const result = metrics.getMetrics();
            expect(result.cache.hitRate).toBe(0);
        });
    });

    describe('reset', () => {
        it('should clear all metrics on reset', () => {
            metrics.recordEngineSearch('bing', 100, true);
            metrics.recordCacheHit();
            metrics.resetMetrics();

            const result = metrics.getMetrics();
            expect(Object.keys(result.engines)).toHaveLength(0);
            expect(result.cache.hits).toBe(0);
        });
    });
});
