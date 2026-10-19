import axios from 'axios';
import { SearchResult } from '../../types.js';
import { AppConfig } from '../../config.js';
import { metrics } from '../metrics.js';
import { AppError, isRetryableError, extractErrorStatus, extractErrorCode, extractErrorHint, extractErrorDetails } from '../errors.js';
import {
    Semaphore,
    SearchEngineExecutorMap,
    SearchExecutionFailure
} from './searchService.js';
import { recordEngineSuccess, tripEngineCircuit } from './engineCircuitBreaker.js';

/**
 * P1-5：按引擎细粒度并发限流（避免突发并发把 sogou/baidu 等脆弱引擎打满 10s 超时或触发反爬）：
 * 实测 8 个不同查询并发打向 sogou 时，第 4 个起全部吃满 10s 超时。
 */
const DEFAULT_ENGINE_CONCURRENCY_LIMITS: Record<string, number> = {
    sogou: 3,
    baidu: 4,
    startpage: 2
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
                lastError = error;
                if (signal.aborted || Date.now() >= deadlineAt) {
                    break;
                }
                if (attempt < 2 && isRetryableEngineError(error)) {
                    const backoff = computeRetryBackoff(error, attempt);
                    if (Date.now() + backoff >= deadlineAt) {
                        break;
                    }
                    console.error(`⚠️ Engine ${engine} failed (attempt ${attempt + 1}/3), retrying in ${backoff}ms:`, error instanceof Error ? error.message : String(error));
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

    const engineResults = await Promise.all(tasks.map((task, index) => {
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
                controller?.abort(new AppError({
                    code: 'network_timeout',
                    retryable: true,
                    engine,
                    message: `Engine timeout after ${wait}ms`
                }));
                engineMetrics[index] = { engine, ms: wait, count: 0, error: `timeout after ${wait}ms`, timedOut: true };
                if (engine && !partialFailures.some((failure) => failure.engine === engine)) {
                    partialFailures.push({
                        engine,
                        code: 'engine_error',
                        errorCode: 'network_timeout',
                        retryable: true,
                        message: buildHintedMessage(engine, `Engine timeout after ${wait}ms (no response in time)`)
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
    }));

    executableEngines.forEach((engine, index) => {
        const engineResult = engineResults[index] ?? [];
        const elapsedMs = engineMetrics[index]?.ms ?? (Date.now() - (startedAtByIndex[index] ?? Date.now()));
        metrics.recordEngineSearch(engine, elapsedMs, engineResult.length > 0);
    });

    let directAnswer: string | undefined;
    for (const engineResult of engineResults) {
        const candidate = (engineResult as { directAnswer?: unknown }).directAnswer;
        if (typeof candidate === 'string' && candidate.length > 0) {
            directAnswer = candidate;
            break;
        }
    }

    executableEngines.forEach((engine, index) => {
        const executor = engineMap[engine];
        const limitForEngine = limits[index] ?? 0;
        const engineResult = engineResults[index] ?? [];
        if (executor && limitForEngine > 0 && engineResult.length === 0) {
            if (!partialFailures.some((failure) => failure.engine === engine)) {
                partialFailures.push({
                    engine,
                    code: 'no_results',
                    retryable: false,
                    message: 'Engine returned no results for the allocated quota'
                });
            }
        }
    });

    return {
        engineResults,
        partialFailures,
        engineMetrics,
        directAnswer
    };
}
