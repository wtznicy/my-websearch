import axios from 'axios';
import { SearchResult } from '../../types.js';
import { AppConfig } from '../../config.js';
import { metrics } from '../metrics.js';
import { AppError, isRetryableError, extractErrorStatus, extractErrorCode, extractErrorHint, extractErrorDetails } from '../errors.js';
import { Semaphore } from '../../utils/concurrency.js';
import type { SearchEngineExecutorMap, SearchExecutionFailure } from './searchTypes.js';
import { recordEngineSuccess, tripEngineCircuit } from './engineCircuitBreaker.js';
import { hintProxyConnectionError } from '../../utils/httpRequest.js';
import { recordEngineLatency, compactEngineLatencyFile, type EngineLatencySample } from '../engineLatency.js';
import { stripCssFragments } from '../../utils/htmlText.js';

/**
 * P1-5：按引擎细粒度并发限流（避免突发并发把 sogou/baidu 等脆弱引擎打满 10s 超时或触发反爬）：
 * 实测 8 个不同查询并发打向 sogou 时，第 4 个起全部吃满 10s 超时。
 */
const DEFAULT_ENGINE_CONCURRENCY_LIMITS: Record<string, number> = {
    sogou: 3,
    baidu: 4,
    startpage: 2,
    // P2-16：bing 此前没有闸门，全局 semaphore 允许 20 并发压同一个 cachedBingSession，
    // 安全性完全押注 Rust 侧实现；给 4-6 之间的保守值，避免会话被并发打散。
    bing: 4
};

let engineConcurrencyLimits: Record<string, number> = { ...DEFAULT_ENGINE_CONCURRENCY_LIMITS };
const engineSemaphores = new Map<string, Semaphore>();

function getEngineSemaphore(engine: string): Semaphore | undefined {
    const normalized = engine.trim().toLowerCase();
    const limit = engineConcurrencyLimits[normalized];
    if (!limit || limit <= 0) {
        return undefined;
    }
    let sem = engineSemaphores.get(normalized);
    if (!sem) {
        sem = new Semaphore(limit, Math.max(32, limit * 8));
        engineSemaphores.set(normalized, sem);
    }
    return sem;
}

export async function withEngineConcurrencySlot<T>(
    engine: string,
    deadlineAt: number,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>
): Promise<T> {
    const sem = getEngineSemaphore(engine);
    if (!sem) {
        return fn();
    }
    await sem.acquire(deadlineAt, signal);
    try {
        return await fn();
    } finally {
        sem.release();
    }
}

export function configureEngineConcurrencyLimitsForTests(overrides?: Record<string, number>): void {
    engineConcurrencyLimits = overrides ? { ...overrides } : { ...DEFAULT_ENGINE_CONCURRENCY_LIMITS };
    engineSemaphores.clear();
}

export function isRetryableEngineError(error: unknown): boolean {
    return isRetryableError(error);
}

export function computeRetryBackoff(error: unknown, attempt: number): number {
    const status = extractErrorStatus(error);
    if (status === 429) {
        let retryAfter: number | undefined;
        if (axios.isAxiosError(error) && error.response?.headers) {
            retryAfter = Number(error.response.headers['retry-after']);
        }
        if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
            return retryAfter * 1000;
        }
        return 1000 * (2 ** attempt) + Math.random() * 250;
    }
    return 300 * (2 ** attempt) + Math.random() * 100;
}

export function buildHintedMessage(engine: string, message: string, customHint?: string): string {
    const hint = customHint || '可换用其他引擎（engines 参数）或稍后重试';
    if (message.includes('Hint:')) {
        return message;
    }
    return `${message} | Hint: 引擎 ${engine} 暂不可用，${hint}`;
}

export function truncateMetricError(message: string): string {
    const normalized = message.replace(/\s+/g, ' ').trim();
    return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

import type { RequestContext } from '../requestContext.js';

export interface ExecutePrimaryEnginesOptions {
    query: string;
    searchQuery: string;
    executableEngines: string[];
    limits: number[];
    effectiveSearchMode?: AppConfig['searchMode'];
    engineMap: SearchEngineExecutorMap;
    deadlineAt: number;
    perEngineTimeoutMs: number;
    /** 满足早退的最小结果数（通常来自 minResults）；未提供时用 limit 总和 */
    satisfiedResults?: number;
    /**
     * 早退计数用的过滤谓词（placeholder / site 约束）。
     * P1-10：必须先过滤再计数，否则带 site: 的查询会用膨胀计数提前 abort 其它引擎。
     */
    countableResult?: (result: SearchResult) => boolean;
    signal?: AbortSignal;
    timeRange?: 'day' | 'week' | 'month' | 'year';
    site?: string[];
    requestContext?: RequestContext;
}

export interface ExecutePrimaryEnginesResult {
    engineResults: SearchResult[][];
    partialFailures: SearchExecutionFailure[];
    engineMetrics: Array<{ engine: string; ms: number; count: number; error?: string; timedOut?: boolean }>;
    directAnswer?: string;
    /** 是否因为结果已足够而提前返回（未完成的引擎被 abort，不计失败、不计延迟样本） */
    earlyReturn?: boolean;
    /** 被提前取消的引擎（不是返回 0 条，而是没来得及） */
    cancelledEngines?: Array<{ engine: string; reason: 'early_return'; message: string }>;
}

/** 结果足够后给慢引擎的宽限窗口：有人已满足 minResults 时，最多再等这么久 */
const EARLY_RETURN_GRACE_MS = 800;

function countUniqueResultUrls(
    results: Array<SearchResult[] | undefined>,
    countable: (result: SearchResult) => boolean
): number {
    const seen = new Set<string>();
    for (const engineResult of results) {
        for (const item of engineResult ?? []) {
            if (item.url && countable(item)) {
                seen.add(item.url);
            }
        }
    }
    return seen.size;
}

function resolveSatisfiedTarget(limits: number[], requested?: number): number {
    const total = limits.reduce((sum, value) => sum + Math.max(0, value), 0);
    const fallback = Math.max(1, total);
    if (!requested || requested <= 0) {
        return fallback;
    }
    return Math.max(1, Math.min(requested, fallback));
}

/**
 * 收集主引擎结果，「满意即止」：
 * 只要已完成引擎的去重结果数达到目标，就再给未完成引擎一个宽限窗口（800ms），
 * 到期直接 abort 并返回——避免最慢的那个引擎把整次搜索拖满
 * （实测中文 baidu 9.3s vs sogou 3.0s）。单引擎不启用：用户点名一个引擎时就该给它完整预算。
 */
async function collectPrimaryResults(
    races: Array<Promise<SearchResult[]>>,
    context: {
        satisfiedTarget: number;
        controllers: AbortController[];
        executableEngines: string[];
        countableResult: (result: SearchResult) => boolean;
    }
): Promise<{ engineResults: SearchResult[][]; earlyReturn: boolean; skipped: Set<number> }> {
    const settled: Array<SearchResult[] | undefined> = new Array(races.length).fill(undefined);
    const skipped = new Set<number>();
    let earlyReturn = false;

    if (races.length <= 1) {
        settled[0] = (await races[0]) ?? [];
        return { engineResults: settled.map((results) => results ?? []), earlyReturn: false, skipped };
    }

    await new Promise<void>((resolve) => {
        let remaining = races.length;
        let graceTimer: NodeJS.Timeout | undefined;
        let finished = false;
        const finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            if (graceTimer) {
                clearTimeout(graceTimer);
            }
            resolve();
        };
        const maybeArmGrace = () => {
            if (finished || graceTimer) {
                return;
            }
            if (countUniqueResultUrls(settled, context.countableResult) < context.satisfiedTarget) {
                return;
            }
            graceTimer = setTimeout(() => {
                earlyReturn = true;
                finish();
            }, EARLY_RETURN_GRACE_MS);
        };
        races.forEach((race, index) => {
            race.then((results) => {
                settled[index] = results;
                remaining -= 1;
                maybeArmGrace();
                if (remaining === 0) {
                    finish();
                }
            }).catch(() => {
                settled[index] = [];
                remaining -= 1;
                maybeArmGrace();
                if (remaining === 0) {
                    finish();
                }
            });
        });
    });

    if (earlyReturn) {
        for (let index = 0; index < settled.length; index += 1) {
            if (settled[index] !== undefined) {
                continue;
            }
            skipped.add(index);
            settled[index] = [];
            context.controllers[index]?.abort(new AppError({
                code: 'engine_timeout',
                retryable: false,
                message: `Skipped: ${context.satisfiedTarget} results already collected (early return)`
            }));
        }
    }

    return { engineResults: settled.map((results) => results ?? []), earlyReturn, skipped };
}

export async function executePrimaryEngines(
    options: ExecutePrimaryEnginesOptions
): Promise<ExecutePrimaryEnginesResult> {
    const {
        searchQuery,
        executableEngines,
        limits,
        effectiveSearchMode,
        engineMap,
        deadlineAt,
        perEngineTimeoutMs,
        signal: outerSignal,
        timeRange,
        site,
        requestContext
    } = options;

    const partialFailures: SearchExecutionFailure[] = [];
    const engineMetrics: Array<{ engine: string; ms: number; count: number; error?: string; timedOut?: boolean }> = [];
    const startedAtByIndex: number[] = executableEngines.map(() => Date.now());
    const controllers: AbortController[] = executableEngines.map(() => new AbortController());

    if (outerSignal) {
        if (outerSignal.aborted) {
            controllers.forEach((c) => c.abort(outerSignal.reason));
        } else {
            outerSignal.addEventListener('abort', () => {
                controllers.forEach((c) => c.abort(outerSignal.reason));
            }, { once: true });
        }
    }

    const tasks = executableEngines.map(async (engine, index) => {
        const executor = engineMap[engine];
        const engineLimit = limits[index] ?? 0;
        const startedAt = startedAtByIndex[index] ?? Date.now();
        const controller = controllers[index]!;
        const { signal } = controller;
        let resultCount = 0;

        if (!executor) {
            partialFailures.push({
                engine,
                code: 'unsupported_engine',
                retryable: false,
                message: `Unsupported search engine: ${engine}`
            });
            return [];
        }

        if (engineLimit <= 0) {
            return [];
        }

        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (signal.aborted || Date.now() >= deadlineAt) {
                break;
            }
            try {
                const results = await withEngineConcurrencySlot(engine, deadlineAt, signal, () =>
                    executor(searchQuery, engineLimit, {
                        searchMode: effectiveSearchMode,
                        signal,
                        timeRange,
                        site,
                        requestContext
                    })
                );
                if (signal.aborted) {
                    return [];
                }
                if (attempt > 0) {
                    console.error(`✅ Engine ${engine} recovered after ${attempt} retries`);
                }
                // 成功即清零连续失败计数，避免一次瞬时 202/429 让后续冷却一直指数级放大
                recordEngineSuccess(engine);
                resultCount = results.length;
                if (!engineMetrics[index]?.timedOut) {
                    engineMetrics[index] = { engine, ms: Date.now() - startedAt, count: resultCount };
                }
                return results;
            } catch (error) {
                // search 路径此前从不经过 hintProxyConnectionError，所以死代理的失败既没有提示、
                // 也照常重试 3 次（10s × 3 = 30s）。这里统一归类，确定性的代理失败不再重试。
                const normalizedError = hintProxyConnectionError(error);
                lastError = normalizedError;
                if (signal.aborted || Date.now() >= deadlineAt) {
                    break;
                }
                if (attempt < 2 && isRetryableEngineError(normalizedError)) {
                    const backoff = computeRetryBackoff(normalizedError, attempt);
                    if (Date.now() + backoff >= deadlineAt) {
                        break;
                    }
                    console.error(`⚠️ Engine ${engine} failed (attempt ${attempt + 1}/3), retrying in ${backoff}ms:`, normalizedError instanceof Error ? normalizedError.message : String(normalizedError));
                    await sleepWithSignal(backoff, signal);
                    if (signal.aborted || Date.now() >= deadlineAt) {
                        break;
                    }
                } else {
                    break;
                }
            }
        }

        if (signal.aborted || engineMetrics[index]?.timedOut) {
            return [];
        }

        const metricError = lastError instanceof Error ? lastError.message : String(lastError);
        if (!engineMetrics[index]?.timedOut) {
            engineMetrics[index] = { engine, ms: Date.now() - startedAt, count: resultCount, error: truncateMetricError(metricError) };
        }
        if (!partialFailures.some((failure) => failure.engine === engine)) {
            const errorCode = extractErrorCode(lastError);
            const status = extractErrorStatus(lastError);
            const hint = extractErrorHint(lastError);
            const details = extractErrorDetails(lastError);
            if (status === 429 || errorCode === 'rate_limited' || status === 202 || errorCode === 'bot_challenge') {
                tripEngineCircuit(engine);
            } else if (errorCode === 'proxy_unreachable' && !isRetryableEngineError(lastError)) {
                // 只对「确定性代理失败」短冷却。普通 network_error 不进熔断：
                // 无代理用户（例如海外用户）遇到一次网络抖动就被静默停用 60s，代价远大于收益。
                tripEngineCircuit(engine, 60_000);
            }
            partialFailures.push({
                engine,
                code: 'engine_error',
                ...(errorCode ? { errorCode } : {}),
                ...(status !== undefined ? { status } : {}),
                ...(hint ? { hint } : {}),
                ...(details ? { details } : {}),
                retryable: isRetryableEngineError(lastError),
                message: buildHintedMessage(engine, metricError, hint)
            });
        }
        return [];
    });

    const engineRaces = tasks.map((task, index) => {
        const engine = executableEngines[index] ?? '';
        const controller = controllers[index];
        const remaining = deadlineAt - Date.now();
        const isSingleEngine = executableEngines.length === 1;
        const engineBudget = isSingleEngine
            ? Math.max(perEngineTimeoutMs, remaining - 1000)
            : (['startpage', 'bing'].includes(engine)
                ? Math.max(perEngineTimeoutMs, Math.min(remaining - 500, Math.round(perEngineTimeoutMs * 1.5)))
                : perEngineTimeoutMs);
        const wait = Math.max(0, Math.min(remaining, engineBudget));
        return new Promise<SearchResult[]>((resolve) => {
            let done = false;
            const timer = setTimeout(() => {
                done = true;
                // 预算耗尽 ≠ 网络错误：这是「搜索总 deadline 到了，引擎还没回」。
                // 之前一律记成 network_timeout，会污染健康统计和路由权重（把慢引擎判成坏引擎）。
                controller?.abort(new AppError({
                    code: 'engine_timeout',
                    retryable: false,
                    engine,
                    message: `Engine budget exhausted after ${wait}ms (search deadline reached), not a network error`
                }));
                engineMetrics[index] = { engine, ms: wait, count: 0, error: `budget exhausted after ${wait}ms`, timedOut: true };
                if (engine && !partialFailures.some((failure) => failure.engine === engine)) {
                    partialFailures.push({
                        engine,
                        code: 'engine_error',
                        errorCode: 'engine_timeout',
                        retryable: false,
                        message: buildHintedMessage(engine, `Engine budget exhausted after ${wait}ms because the search deadline was reached (no response in time; not a network error)`)
                    });
                }
                resolve([]);
            }, wait);
            task.then((results) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                resolve(results);
            }).catch(() => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                resolve([]);
            });
        });
    });

    const satisfiedTarget = resolveSatisfiedTarget(limits, options.satisfiedResults);
    const collected = await collectPrimaryResults(engineRaces, {
        satisfiedTarget,
        controllers,
        executableEngines,
        countableResult: options.countableResult ?? (() => true)
    });
    const engineResults = collected.engineResults;
    // 早退时被 abort 的引擎要显式暴露：否则外部只看到「没有结果」，无法区分
    // 「引擎返回 0 条」与「被取消、没来得及」。
    const cancelledEngines = [...collected.skipped]
        .map((index) => executableEngines[index])
        .filter((engine): engine is string => Boolean(engine))
        .map((engine) => ({
            engine,
            reason: 'early_return' as const,
            message: `Cancelled after ${satisfiedTarget} usable results were already collected`
        }));

    const latencySamples: EngineLatencySample[] = [];
    executableEngines.forEach((engine, index) => {
        // 提前返回时被 abort 的引擎：既没失败也没完成，不能进延迟样本，否则会污染 p50
        if (collected.skipped.has(index)) {
            return;
        }
        const engineResult = engineResults[index] ?? [];
        const elapsedMs = engineMetrics[index]?.ms ?? (Date.now() - (startedAtByIndex[index] ?? Date.now()));
        metrics.recordEngineSearch(engine, elapsedMs, engineResult.length > 0);
        // 「拿到响应」与「有结果」不是一回事：0 结果但没报错说明链路正常，延迟数据仍然有效
        const metric = engineMetrics[index];
        latencySamples.push({
            engine,
            ms: elapsedMs,
            ok: !metric?.error && !metric?.timedOut,
            at: Date.now()
        });
    });
    // 跨进程持久化，供 doctor 展示与后续「按历史耗时做路由」使用
    recordEngineLatency(latencySamples);
    compactEngineLatencyFile();

    let directAnswer: string | undefined;
    for (const engineResult of engineResults) {
        const candidate = (engineResult as { directAnswer?: unknown }).directAnswer;
        if (typeof candidate === 'string' && candidate.length > 0) {
            // 出口兜底：任何引擎漏网的 CSS/样式块都在这里再清一次
            const cleaned = stripCssFragments(candidate);
            if (cleaned.length > 0) {
                directAnswer = cleaned;
                break;
            }
        }
    }

    executableEngines.forEach((engine, index) => {
        // 早退时被 abort 的引擎不是「没结果」，而是「没来得及」——不要记成 no_results
        if (collected.skipped.has(index)) {
            return;
        }
        const executor = engineMap[engine];
        const limitForEngine = limits[index] ?? 0;
        const engineResult = engineResults[index] ?? [];
        if (executor && limitForEngine > 0 && engineResult.length === 0) {
            if (!partialFailures.some((failure) => failure.engine === engine)) {
                partialFailures.push({
                    engine,
                    code: 'no_results',
                    retryable: false,
                    // 不再说「for the allocated quota」——配额不是原因，查询/过滤太窄才是
                    message: `Engine returned no results (requested ${limitForEngine}); its query matching or filters may be too narrow`
                });
            }
        }
    });

    return {
        engineResults,
        partialFailures,
        engineMetrics,
        directAnswer,
        ...(cancelledEngines.length > 0 ? { cancelledEngines } : {}),
        ...(collected.earlyReturn ? { earlyReturn: true } : {})
    };
}
