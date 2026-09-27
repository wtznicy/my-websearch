import axios from 'axios';
import { SearchResult } from '../../types.js';
import { AppConfig } from '../../config.js';
import { sleep } from '../../utils/timing.js';
import { metrics } from '../metrics.js';
import { extractErrorStatus, isExplicitNonRetryable } from '../errors.js';
import {
    SearchEngineExecutorMap,
    SearchExecutionFailure
} from './searchService.js';

export function isRetryableEngineError(error: unknown): boolean {
    if (isExplicitNonRetryable(error)) {
        return false;
    }
    const status = extractErrorStatus(error);
    if (typeof status === 'number') {
        return status === 429 || status >= 500;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/anti-bot|verification page|challenge page|captcha|验证码|人机验证/i.test(message)) {
        return false;
    }
    return true;
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

export function buildHintedMessage(engine: string, message: string): string {
    const hint = '可换用其他引擎（engines 参数）或稍后重试';
    if (message.includes('Hint:')) {
        return message;
    }
    return `${message} | Hint: 引擎 ${engine} 暂不可用，${hint}`;
}

export function truncateMetricError(message: string): string {
    const normalized = message.replace(/\s+/g, ' ').trim();
    return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

export interface ExecutePrimaryEnginesOptions {
    query: string;
    searchQuery: string;
    executableEngines: string[];
    limits: number[];
    effectiveSearchMode?: AppConfig['searchMode'];
    engineMap: SearchEngineExecutorMap;
    deadlineAt: number;
    perEngineTimeoutMs: number;
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
        perEngineTimeoutMs
    } = options;

    const partialFailures: SearchExecutionFailure[] = [];
    const engineMetrics: Array<{ engine: string; ms: number; count: number; error?: string; timedOut?: boolean }> = [];
    const startedAtByIndex: number[] = executableEngines.map(() => Date.now());

    const tasks = executableEngines.map(async (engine, index) => {
        const executor = engineMap[engine];
        const engineLimit = limits[index] ?? 0;
        const startedAt = startedAtByIndex[index] ?? Date.now();
        let resultCount = 0;

        if (!executor) {
            partialFailures.push({
                engine,
                code: 'unsupported_engine',
                message: `Unsupported search engine: ${engine}`
            });
            return [];
        }

        if (engineLimit <= 0) {
            return [];
        }

        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const results = await executor(searchQuery, engineLimit, { searchMode: effectiveSearchMode });
                if (attempt > 0) {
                    console.error(`✅ Engine ${engine} recovered after ${attempt} retries`);
                }
                resultCount = results.length;
                if (!engineMetrics[index]?.timedOut) {
                    engineMetrics[index] = { engine, ms: Date.now() - startedAt, count: resultCount };
                }
                return results;
            } catch (error) {
                lastError = error;
                if (attempt < 2 && isRetryableEngineError(error)) {
                    const backoff = computeRetryBackoff(error, attempt);
                    console.error(`⚠️ Engine ${engine} failed (attempt ${attempt + 1}/3), retrying in ${backoff}ms:`, error instanceof Error ? error.message : String(error));
                    await sleep(backoff);
                } else {
                    break;
                }
            }
        }

        const metricError = lastError instanceof Error ? lastError.message : String(lastError);
        if (!engineMetrics[index]?.timedOut) {
            engineMetrics[index] = { engine, ms: Date.now() - startedAt, count: resultCount, error: truncateMetricError(metricError) };
        }
        partialFailures.push({
            engine,
            code: 'engine_error',
            message: buildHintedMessage(engine, metricError)
        });
        return [];
    });

    const engineResults = await Promise.all(tasks.map((task, index) => {
        const engine = executableEngines[index] ?? '';
        const remaining = deadlineAt - Date.now();
        const wait = Math.max(0, Math.min(remaining, perEngineTimeoutMs));
        return new Promise<SearchResult[]>((resolve) => {
            let done = false;
            const timer = setTimeout(() => {
                done = true;
                engineMetrics[index] = { engine, ms: wait, count: 0, error: `timeout after ${wait}ms`, timedOut: true };
                if (engine && !partialFailures.some((failure) => failure.engine === engine)) {
                    partialFailures.push({
                        engine,
                        code: 'engine_error',
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
            });
        });
    }));

    executableEngines.forEach((engine, index) => {
        const engineResult = engineResults[index] ?? [];
        metrics.recordEngineSearch(engine, Date.now() - (startedAtByIndex[index] ?? Date.now()), engineResult.length > 0);
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
