import fs from 'node:fs';
import path from 'node:path';
import { getAppConfigDir } from '../configLoader.js';

/**
 * 引擎延迟采样（跨进程持久化）。
 *
 * 为什么需要：`metrics` 里的滑动窗口是**进程内**的——CLI 每次搜索都是新进程，
 * MCP server 重启也会清零。而「按历史耗时做路由」需要跨会话的数据，
 * 否则每次启动都在冷启动状态，路由权重永远学不出来。
 *
 * 存储形态：追加式 JSONL（崩溃安全、无需读改写），doctor 读时按时间窗聚合。
 * 每人每次搜索约写 1~14 行、每行 ~60 字节，一周的量在几百 KB 级别。
 */

export interface EngineLatencySample {
    engine: string;
    ms: number;
    ok: boolean;
    at: number;
}

export interface EngineLatencyStat {
    engine: string;
    samples: number;
    successRate: number;
    p50: number;
    p95: number;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** 低于该值的"耗时"不可能来自一次真实网络调用（测试假引擎 / 缓存命中），不入库也不参与统计 */
const MIN_MEANINGFUL_LATENCY_MS = 10;

export function engineLatencyPath(env: NodeJS.ProcessEnv = process.env): string {
    return env.MYWEBSEARCH_LATENCY_PATH || path.join(getAppConfigDir(env), 'engine-latency.jsonl');
}

/** 追加采样；任何 I/O 失败都静默忽略——采样不能影响搜索本身 */
export function recordEngineLatency(samples: EngineLatencySample[], env: NodeJS.ProcessEnv = process.env): void {
    const meaningful = samples.filter((sample) => sample.ms >= MIN_MEANINGFUL_LATENCY_MS);
    if (meaningful.length === 0) {
        return;
    }
    try {
        const filePath = engineLatencyPath(env);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(
            filePath,
            meaningful.map((s) => JSON.stringify({ e: s.engine, ms: Math.round(s.ms), ok: s.ok, t: s.at })).join('\n') + '\n',
            'utf8'
        );
    } catch {
        // 磁盘只读、权限不足等场景下放弃采样
    }
}

/** 线性插值百分位（输入需已升序） */
export function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
        return 0;
    }
    if (sorted.length === 1) {
        return sorted[0] ?? 0;
    }
    const rank = (p / 100) * (sorted.length - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    const lowValue = sorted[low] ?? 0;
    const highValue = sorted[high] ?? lowValue;
    return Math.round(lowValue + (highValue - lowValue) * (rank - low));
}

/** 读取并聚合最近的采样；文件不存在时返回空数组 */
export function readEngineLatencyStats(
    options: { env?: NodeJS.ProcessEnv; now?: number; retentionMs?: number; maxSamplesPerEngine?: number } = {}
): EngineLatencyStat[] {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now();
    const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    const maxSamples = options.maxSamplesPerEngine ?? 500;

    let raw: string;
    try {
        raw = fs.readFileSync(engineLatencyPath(env), 'utf8');
    } catch {
        return [];
    }

    const cutoff = now - retentionMs;
    const byEngine = new Map<string, Array<{ ms: number; ok: boolean }>>();

    for (const line of raw.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        let parsed: { e?: unknown; ms?: unknown; ok?: unknown; t?: unknown };
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        const engine = typeof parsed.e === 'string' ? parsed.e : '';
        const ms = Number(parsed.ms);
        const at = Number(parsed.t);
        if (!engine || !Number.isFinite(ms) || ms < 0 || !Number.isFinite(at) || at < cutoff) {
            continue;
        }
        const bucket = byEngine.get(engine) ?? [];
        bucket.push({ ms, ok: parsed.ok === true });
        byEngine.set(engine, bucket);
    }

    const stats: EngineLatencyStat[] = [];
    for (const [engine, bucket] of byEngine) {
        // 过滤掉「不可能是一次真实网络调用」的样本：测试用假引擎、缓存命中都会产生 0-9ms 记录，
        // 混进来会把 p50 拉到 0（实测 bing p50=0ms / n=195），指标失去诊断价值。
        const recent = bucket.slice(-maxSamples).filter((sample) => sample.ms >= MIN_MEANINGFUL_LATENCY_MS);
        if (recent.length === 0) {
            continue;
        }
        const durations = recent.map((s) => s.ms).sort((a, b) => a - b);
        const success = recent.filter((s) => s.ok).length;
        stats.push({
            engine,
            samples: recent.length,
            successRate: recent.length > 0 ? Math.round((success / recent.length) * 100) : 0,
            p50: percentile(durations, 50),
            p95: percentile(durations, 95)
        });
    }

    return stats.sort((a, b) => a.p50 - b.p50);
}

/** 文件过大时裁剪到保留窗口内（默认 7 天），避免无界增长 */
export function compactEngineLatencyFile(env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
    try {
        const filePath = engineLatencyPath(env);
        const stat = fs.statSync(filePath);
        if (stat.size < MAX_FILE_BYTES) {
            return;
        }
        const cutoff = now - DEFAULT_RETENTION_MS;
        const kept = fs.readFileSync(filePath, 'utf8')
            .split('\n')
            .filter((line) => {
                if (!line.trim()) {
                    return false;
                }
                try {
                    const parsed = JSON.parse(line) as { t?: unknown };
                    return Number(parsed.t) >= cutoff;
                } catch {
                    return false;
                }
            });
        fs.writeFileSync(filePath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
    } catch {
        // 裁剪失败不影响后续读写
    }
}
