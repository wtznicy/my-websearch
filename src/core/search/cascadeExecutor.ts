import { SearchResult } from '../../types.js';
import { AppConfig } from '../../config.js';
import { countUsableResults } from './resultRanking.js';
import { isEngineCircuitOpen } from './engineCircuitBreaker.js';
import { isKnownUnreachableOverseasEngine } from '../../utils/overseasProbe.js';
import { metrics } from '../metrics.js';
import { SUPPORTED_SEARCH_ENGINES } from './searchEngines.js';
import {
    SearchEngineExecutorMap,
    SearchExecutionFailure,
    mergeSearchResults,
    isPlaceholderResult
} from './searchService.js';
import {
    buildHintedMessage,
    truncateMetricError
} from './engineExecutor.js';

export interface ExecuteCascadeOptions {
    cleanQuery: string;
    searchQuery: string;
    minResults: number;
    initialMerged: SearchResult[];
    initialEngineResults: SearchResult[][];
    engines: string[];
    engineMap: SearchEngineExecutorMap;
    effectiveSearchMode?: AppConfig['searchMode'];
    deadlineAt: number;
    perEngineTimeoutMs: number;
}

export interface ExecuteCascadeResult {
    merged: SearchResult[];
    cascadedEngines: string[];
    cascadeFailures: SearchExecutionFailure[];
    cascadeMetrics: Array<{ engine: string; ms: number; count: number; error?: string; timedOut?: boolean }>;
}

export async function executeCascade(
    options: ExecuteCascadeOptions
): Promise<ExecuteCascadeResult> {
    const {
        cleanQuery,
        searchQuery,
        minResults,
        initialMerged,
        initialEngineResults,
        engines,
        engineMap,
        effectiveSearchMode,
        deadlineAt,
        perEngineTimeoutMs
    } = options;

    let merged = initialMerged;
    const engineResults = [...initialEngineResults];
    const cascadedEngines: string[] = [];
    const cascadeFailures: SearchExecutionFailure[] = [];
    const cascadeMetrics: Array<{ engine: string; ms: number; count: number; error?: string; timedOut?: boolean }> = [];

    const CASCADE_BATCH_SIZE = 2;
    const MIN_CASCADE_BATCH_BUDGET_MS = 3000;
    const MAX_CASCADE_BATCHES = 3;

    const usableCount = countUsableResults(merged, cleanQuery);
    if (!minResults || minResults <= usableCount) {
        return {
            merged,
            cascadedEngines,
            cascadeFailures,
            cascadeMetrics
        };
    }

    const usedEngines = new Set(engines);
    const hasExaKey = Boolean(process.env.EXA_API_KEY?.trim());
    const candidates = SUPPORTED_SEARCH_ENGINES.filter(
        (engine) => !usedEngines.has(engine)
            && typeof engineMap[engine] === 'function'
            && !isEngineCircuitOpen(engine)
            && !isKnownUnreachableOverseasEngine(engine)
            && (engine !== 'exa' || hasExaKey)
    );

    let cascadeBatches = 0;
    for (
        let cursor = 0;
        cursor < candidates.length
        && countUsableResults(merged, cleanQuery) < minResults
        && cascadeBatches < MAX_CASCADE_BATCHES;
        cursor += CASCADE_BATCH_SIZE
    ) {
        const remaining = deadlineAt - Date.now();
        if (remaining < MIN_CASCADE_BATCH_BUDGET_MS) {
            break;
        }
        cascadeBatches += 1;
        const batch = candidates.slice(cursor, cursor + CASCADE_BATCH_SIZE);
        const gap = minResults - countUsableResults(merged, cleanQuery);

        const runCandidate = (candidate: string): Promise<SearchResult[]> => new Promise((resolve, reject) => {
            let done = false;
            const cascadeStartedAt = Date.now();
            const wait = Math.max(0, Math.min(remaining, perEngineTimeoutMs));
            let cascadeTimedOut = false;
            const timer = setTimeout(() => {
                done = true;
                cascadeTimedOut = true;
                cascadeMetrics.push({ engine: candidate, ms: wait, count: 0, error: `timeout after ${wait}ms`, timedOut: true });
                cascadeFailures.push({
                    engine: candidate,
                    code: 'engine_error',
                    message: buildHintedMessage(candidate, `Engine timeout after ${wait}ms (no response in time)`)
                });
                resolve([]);
            }, wait);

            (async () => {
                const results = await engineMap[candidate]!(searchQuery, gap, { searchMode: effectiveSearchMode });
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    if (!cascadeTimedOut) {
                        cascadeMetrics.push({ engine: candidate, ms: Date.now() - cascadeStartedAt, count: results.length });
                        metrics.recordEngineSearch(candidate, Date.now() - cascadeStartedAt, results.length > 0);
                    }
                    resolve(results);
                }
            })().catch((error: unknown) => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    if (!cascadeTimedOut) {
                        cascadeMetrics.push({
                            engine: candidate,
                            ms: Date.now() - cascadeStartedAt,
                            count: 0,
                            error: truncateMetricError(error instanceof Error ? error.message : String(error))
                        });
                        metrics.recordEngineSearch(candidate, Date.now() - cascadeStartedAt, false);
                    }
                    reject(error);
                }
            });
        });

        const batchStartLength = merged.length;
        let batchAllReturnedNonEmpty = true;
        let batchNewResults = 0;
        const settled = await Promise.allSettled(batch.map((candidate) => runCandidate(candidate)));

        for (let index = 0; index < settled.length; index += 1) {
            const candidate = batch[index];
            const outcome = settled[index];
            if (!candidate || !outcome) {
                continue;
            }
            if (outcome.status === 'fulfilled') {
                if (outcome.value.length > 0) {
                    const before = merged.length;
                    cascadedEngines.push(candidate);
                    engineResults.push(outcome.value);
                    merged = mergeSearchResults(engineResults)
                        .filter((result) => !isPlaceholderResult(result));
                    batchNewResults += merged.length - before;
                } else {
                    batchAllReturnedNonEmpty = false;
                    cascadeFailures.push({
                        engine: candidate,
                        code: 'no_results',
                        message: 'Engine returned no results for the cascaded quota'
                    });
                }
            } else {
                batchAllReturnedNonEmpty = false;
                cascadeFailures.push({
                    engine: candidate,
                    code: 'engine_error',
                    message: buildHintedMessage(candidate, outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason))
                });
            }
        }

        if (batchAllReturnedNonEmpty && batchNewResults === 0 && merged.length === batchStartLength) {
            break;
        }
    }

    return {
        merged,
        cascadedEngines,
        cascadeFailures,
        cascadeMetrics
    };
}
