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

// 缓存指标
type CacheMetrics = {
    hits: number;
    misses: number;
};

class MetricsCollector {
    private engineMetrics = new Map<string, EngineMetrics>();
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

    recordEngineSearch(engine: string, durationMs: number, success: boolean): void {
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

    getMetrics(): {
        engines: Record<string, { total: number; success: number; failure: number; avgDurationMs: number }>;
        cache: { hits: number; misses: number; hitRate: number };
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
            }
        };
    }

    resetMetrics(): void {
        this.engineMetrics.clear();
        this.cacheMetrics = { hits: 0, misses: 0 };
    }
}

// 单例导出
export const metrics = new MetricsCollector();
