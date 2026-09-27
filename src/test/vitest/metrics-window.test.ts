import { describe, it, expect, beforeEach } from 'vitest';
import { metrics } from '../../core/metrics.js';

describe('metrics sliding window', () => {
    beforeEach(() => {
        process.env.METRICS_ENABLED = 'true';
        metrics.resetMetrics();
    });

    it('calculates sliding window metrics accurately within window', () => {
        const now = 1000000;
        // 4 successful requests (10ms, 20ms, 30ms, 40ms) and 1 failed request (50ms)
        metrics.recordEngineSearch('bing', 10, true, now - 10000);
        metrics.recordEngineSearch('bing', 20, true, now - 8000);
        metrics.recordEngineSearch('bing', 30, true, now - 6000);
        metrics.recordEngineSearch('bing', 40, true, now - 4000);
        metrics.recordEngineSearch('bing', 50, false, now - 2000);

        const windowed = metrics.getWindowedMetrics(60000, now);
        const bingStats = windowed.bing;

        expect(bingStats).toBeDefined();
        expect(bingStats.total).toBe(5);
        expect(bingStats.success).toBe(4);
        expect(bingStats.failure).toBe(1);
        expect(bingStats.successRate).toBe(80); // 4 / 5 = 80%
        expect(bingStats.avgDurationMs).toBe(30); // (10+20+30+40+50)/5 = 30
        expect(bingStats.p95DurationMs).toBe(50);
    });

    it('filters out events outside the sliding window', () => {
        const now = 1000000;
        const windowMs = 50000; // 50s window

        // Event occurred 60s ago (outside window)
        metrics.recordEngineSearch('duckduckgo', 500, false, now - 60000);
        // Event occurred 10s ago (inside window)
        metrics.recordEngineSearch('duckduckgo', 100, true, now - 10000);

        const windowed = metrics.getWindowedMetrics(windowMs, now);
        const ddgStats = windowed.duckduckgo;

        expect(ddgStats.total).toBe(1);
        expect(ddgStats.success).toBe(1);
        expect(ddgStats.failure).toBe(0);
        expect(ddgStats.successRate).toBe(100);
        expect(ddgStats.avgDurationMs).toBe(100);
    });

    it('clears windowed samples on resetMetrics', () => {
        metrics.recordEngineSearch('baidu', 100, true);
        expect(metrics.getWindowedMetrics().baidu?.total).toBe(1);

        metrics.resetMetrics();
        expect(metrics.getWindowedMetrics().baidu).toBeUndefined();
    });

    it('exports recent metrics in Prometheus format', () => {
        metrics.recordEngineSearch('baidu', 80, true);
        const text = metrics.renderPrometheus();

        expect(text).toContain('mywebsearch_engine_recent_success_rate_percent{engine="baidu"} 100');
        expect(text).toContain('mywebsearch_engine_recent_duration_p95_ms{engine="baidu"} 80');
    });
});
