/**
 * 轻量级 metrics 模块：合并日志/指标/审计为单一出口。
 *
 * - 日志分级：debug / info / warn / error（通过 LOG_LEVEL 控制）
 * - 引擎指标：成功率、缓存命中率、平均响应时间
 * - 安全审计：SSRF 拦截、TLS 验证失败、反爬检测
 *
 * 通过环境变量控制：
 * - LOG_LEVEL=quiet|debug|info|warn|error（默认 info）
 * - METRICS_ENABLED=true 启用指标收集（默认 false）
 * - SECURITY_AUDIT=true 启用安全审计日志（默认 false）
 */

export type LogLevel = 'quiet' | 'debug' | 'info' | 'warn' | 'error';

export type MetricEvent = {
    type: 'engine_search' | 'cache_hit' | 'cache_miss' | 'ssrf_blocked' | 'tls_failed' | 'anti_bot_detected';
    engine?: string;
    durationMs?: number;
    success?: boolean;
    reason?: string;
};

export type SecurityAuditEvent = {
    type: 'ssrf_blocked' | 'tls_failed' | 'anti_bot_detected';
    sourceIp?: string;
    targetUrl: string;
    reason: string;
    details?: Record<string, unknown>;
};

// 引擎指标计数器
type EngineMetrics = {
    total: number;
    success: number;
    failure: number;
    totalDurationMs: number;
};

// 滑动窗口样本事件
export type EngineEventSample = {
    timestamp: number;
    durationMs: number;
    success: boolean;
};

export type SlidingWindowEngineStats = {
    total: number;
    success: number;
    failure: number;
    successRate: number; // 0-100 百分比
    avgDurationMs: number;
    p95DurationMs: number;
};

// 缓存指标
type CacheMetrics = {
    hits: number;
    misses: number;
};

const DEFAULT_SLIDING_WINDOW_MS = 5 * 60 * 1000; // 5 分钟
const MAX_SAMPLES_PER_ENGINE = 500;

class MetricsCollector {
    private engineMetrics = new Map<string, EngineMetrics>();
    private engineSamples = new Map<string, EngineEventSample[]>();
    private cacheMetrics: CacheMetrics = { hits: 0, misses: 0 };

    private get logLevel(): LogLevel {
        return (process.env.LOG_LEVEL as LogLevel) || 'info';
    }

    private get metricsEnabled(): boolean {
        return process.env.METRICS_ENABLED === 'true';
    }

    private get securityAuditEnabled(): boolean {
        return process.env.SECURITY_AUDIT === 'true';
    }

    // ─── 日志 ────────────────────────────────────────────────────────────────

    debug(message: string, context?: Record<string, unknown>): void {
        if (this.shouldLog('debug')) {
            this.emit('DEBUG', message, context);
        }
    }

    info(message: string, context?: Record<string, unknown>): void {
        if (this.shouldLog('info')) {
            this.emit('INFO', message, context);
        }
    }

    warn(message: string, context?: Record<string, unknown>): void {
        if (this.shouldLog('warn')) {
            this.emit('WARN', message, context);
        }
    }

    error(message: string, context?: Record<string, unknown>): void {
        if (this.shouldLog('error')) {
            this.emit('ERROR', message, context);
        }
    }

    private shouldLog(level: LogLevel): boolean {
        if (this.logLevel === 'quiet') return false;
        const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
        return order.indexOf(level) >= order.indexOf(this.logLevel);
    }

    private emit(level: string, message: string, context?: Record<string, unknown>): void {
        const timestamp = new Date().toISOString();
        const entry = { timestamp, level, message, ...context };
        // stdio 模式下保持人类可读格式，daemon 模式下输出 JSON
        if (process.env.MODE === 'stdio' || process.env.MODE === undefined) {
            console.error(`[${timestamp}] ${level}: ${message}`);
        } else {
            console.error(JSON.stringify(entry));
        }
    }

    // ─── 引擎指标 ────────────────────────────────────────────────────────────

    recordEngineSearch(engine: string, durationMs: number, success: boolean, timestamp = Date.now()): void {
        if (!this.metricsEnabled) return;

        let metrics = this.engineMetrics.get(engine);
        if (!metrics) {
            metrics = { total: 0, success: 0, failure: 0, totalDurationMs: 0 };
            this.engineMetrics.set(engine, metrics);
        }

        metrics.total += 1;
        if (success) {
            metrics.success += 1;
        } else {
            metrics.failure += 1;
        }
        metrics.totalDurationMs += durationMs;

        let samples = this.engineSamples.get(engine);
        if (!samples) {
            samples = [];
            this.engineSamples.set(engine, samples);
        }
        samples.push({ timestamp, durationMs, success });
        if (samples.length > MAX_SAMPLES_PER_ENGINE) {
            samples.shift();
        }
    }

    recordCacheHit(): void {
        if (!this.metricsEnabled) return;
        this.cacheMetrics.hits += 1;
    }

    recordCacheMiss(): void {
        if (!this.metricsEnabled) return;
        this.cacheMetrics.misses += 1;
    }

    // ─── 安全审计 ────────────────────────────────────────────────────────────

    recordSecurityEvent(event: SecurityAuditEvent): void {
        if (!this.securityAuditEnabled) return;

        this.emit('SECURITY_AUDIT', `Security event: ${event.type}`, {
            type: event.type,
            sourceIp: event.sourceIp,
            targetUrl: event.targetUrl,
            reason: event.reason,
            details: event.details
        });
    }

    // ─── 指标导出 ────────────────────────────────────────────────────────────

    getWindowedMetrics(windowMs = DEFAULT_SLIDING_WINDOW_MS, now = Date.now()): Record<string, SlidingWindowEngineStats> {
        const result: Record<string, SlidingWindowEngineStats> = {};
        const cutoff = now - windowMs;

        for (const [engine, samples] of this.engineSamples) {
            // 清理过期样本
            const valid = samples.filter((s) => s.timestamp >= cutoff);
            this.engineSamples.set(engine, valid);

            if (valid.length === 0) {
                result[engine] = {
                    total: 0,
                    success: 0,
                    failure: 0,
                    successRate: 0,
                    avgDurationMs: 0,
                    p95DurationMs: 0
                };
                continue;
            }

            const total = valid.length;
            const success = valid.filter((s) => s.success).length;
            const failure = total - success;
            const successRate = Math.round((success / total) * 100);
            const totalDuration = valid.reduce((acc, s) => acc + s.durationMs, 0);
            const avgDurationMs = Math.round(totalDuration / total);

            const sortedDurations = valid.map((s) => s.durationMs).sort((a, b) => a - b);
            const p95Idx = Math.min(Math.floor(0.95 * total), total - 1);
            const p95DurationMs = sortedDurations[p95Idx] ?? 0;

            result[engine] = {
                total,
                success,
                failure,
                successRate,
                avgDurationMs,
                p95DurationMs
            };
        }

        return result;
    }

    getMetrics(): {
        engines: Record<string, { total: number; success: number; failure: number; avgDurationMs: number }>;
        cache: { hits: number; misses: number; hitRate: number };
        windowed?: Record<string, SlidingWindowEngineStats>;
    } {
        const engines: Record<string, { total: number; success: number; failure: number; avgDurationMs: number }> = {};

        for (const [name, metrics] of this.engineMetrics) {
            engines[name] = {
                total: metrics.total,
                success: metrics.success,
                failure: metrics.failure,
                avgDurationMs: metrics.total > 0 ? Math.round(metrics.totalDurationMs / metrics.total) : 0
            };
        }

        const totalCache = this.cacheMetrics.hits + this.cacheMetrics.misses;
        return {
            engines,
            cache: {
                hits: this.cacheMetrics.hits,
                misses: this.cacheMetrics.misses,
                hitRate: totalCache > 0 ? Math.round((this.cacheMetrics.hits / totalCache) * 100) : 0
            },
            windowed: this.getWindowedMetrics()
        };
    }

    resetMetrics(): void {
        this.engineMetrics.clear();
        this.engineSamples.clear();
        this.cacheMetrics = { hits: 0, misses: 0 };
    }

    /**
     * 渲染为 Prometheus 文本格式（供本地 daemon 的 GET /metrics 暴露）。
     * 指标命名遵循 <namespace>_<subsystem>_<name>_<unit> 约定。
     */
    renderPrometheus(): string {
        const snapshot = this.getMetrics();
        const lines: string[] = [];
        const push = (line: string) => lines.push(line);

        push('# HELP mywebsearch_engine_searches_total Total engine search attempts by engine and outcome');
        push('# TYPE mywebsearch_engine_searches_total counter');
        push('# HELP mywebsearch_engine_search_duration_ms_total Cumulative engine search duration in milliseconds');
        push('# TYPE mywebsearch_engine_search_duration_ms_total counter');
        push('# HELP mywebsearch_engine_search_duration_ms_avg Average engine search duration in milliseconds');
        push('# TYPE mywebsearch_engine_search_duration_ms_avg gauge');

        for (const [engine, stats] of Object.entries(snapshot.engines)) {
            const label = `engine="${engine.replace(/"/g, '')}"`;
            push(`mywebsearch_engine_searches_total{${label},outcome="success"} ${stats.success}`);
            push(`mywebsearch_engine_searches_total{${label},outcome="failure"} ${stats.failure}`);
            push(`mywebsearch_engine_searches_total{${label},outcome="total"} ${stats.total}`);
            push(`mywebsearch_engine_search_duration_ms_total{${label}} ${stats.avgDurationMs * stats.total}`);
            push(`mywebsearch_engine_search_duration_ms_avg{${label}} ${stats.avgDurationMs}`);
        }

        if (snapshot.windowed) {
            push('# HELP mywebsearch_engine_recent_success_rate_percent Recent engine search success rate in percent');
            push('# TYPE mywebsearch_engine_recent_success_rate_percent gauge');
            push('# HELP mywebsearch_engine_recent_duration_p95_ms Recent engine search duration p95 in milliseconds');
            push('# TYPE mywebsearch_engine_recent_duration_p95_ms gauge');
            for (const [engine, stats] of Object.entries(snapshot.windowed)) {
                const label = `engine="${engine.replace(/"/g, '')}"`;
                push(`mywebsearch_engine_recent_success_rate_percent{${label}} ${stats.successRate}`);
                push(`mywebsearch_engine_recent_duration_p95_ms{${label}} ${stats.p95DurationMs}`);
            }
        }

        push('# HELP mywebsearch_cache_hits_total Search cache hits');
        push('# TYPE mywebsearch_cache_hits_total counter');
        push(`mywebsearch_cache_hits_total ${snapshot.cache.hits}`);
        push('# HELP mywebsearch_cache_misses_total Search cache misses');
        push('# TYPE mywebsearch_cache_misses_total counter');
        push(`mywebsearch_cache_misses_total ${snapshot.cache.misses}`);
        push('# HELP mywebsearch_cache_hit_rate_percent Search cache hit rate in percent');
        push('# TYPE mywebsearch_cache_hit_rate_percent gauge');
        push(`mywebsearch_cache_hit_rate_percent ${snapshot.cache.hitRate}`);

        // 进程基础指标（便于确认进程存活与内存占用）
        const memory = process.memoryUsage();
        push('# HELP mywebsearch_process_resident_memory_bytes Resident memory size in bytes');
        push('# TYPE mywebsearch_process_resident_memory_bytes gauge');
        push(`mywebsearch_process_resident_memory_bytes ${memory.rss}`);
        push('# HELP mywebsearch_process_uptime_seconds Process uptime in seconds');
        push('# TYPE mywebsearch_process_uptime_seconds counter');
        push(`mywebsearch_process_uptime_seconds ${Math.round(process.uptime())}`);

        return `${lines.join('\n')}\n`;
    }
}

// 单例导出
export const metrics = new MetricsCollector();
