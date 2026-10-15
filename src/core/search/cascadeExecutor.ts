import { SearchResult } from '../../types.js';
import { AppConfig } from '../../config.js';
import { countUsableResults } from './resultRanking.js';
import { isEngineCircuitOpen } from './engineCircuitBreaker.js';
import { isKnownUnreachableOverseasEngine } from '../../utils/overseasProbe.js';
import { metrics } from '../metrics.js';
import { AppError, extractErrorCode, extractErrorDetails, extractErrorStatus, isAppError } from '../errors.js';
import { SUPPORTED_SEARCH_ENGINES } from './searchEngines.js';
import {
    SearchEngineExecutorMap,
    SearchExecutionFailure,
    mergeSearchResults,
    isPlaceholderResult
} from './searchService.js';
import { matchesSiteDomains } from '../../engines/bing/bing.js';
import {
    buildHintedMessage,
    isRetryableEngineError,
    truncateMetricError,
    withEngineConcurrencySlot
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
    allowedEngines?: string[];
    siteDomains?: string[];
}

export interface ExecuteCascadeResult {
    merged: SearchResult[];
    cascadedEngines: string[];
    cascadeFailures: SearchExecutionFailure[];
    cascadeMetrics: Array<{ engine: string; ms: number; count: number; error?: string; timedOut?: boolean }>;
}

const ZH_CASCADE_PRIORITY = [
    'baidu',
    'sogou',
    'bing',
    'juejin',
    'csdn',
    'duckduckgo',
    'brave',
    'exa',
    'startpage'
] as const;

const EN_CASCADE_PRIORITY = [
    'bing',
    'duckduckgo',
    'brave',
    'exa',
    'startpage'
] as const;

/**
 * 按近期滑动窗口健康度对级联候选引擎动态微调排序：
 * - 近期无样本或成功率 ≥50% 的引擎保持在第一梯队（按基础优先级排序）；
 * - 近期出现连续失败/超时（样本数 >0 且成功率 <50%）的慢引擎降级到队尾，避免占满首个级联批次预算。
 */
function sortCandidatesByRecentHealth(candidates: string[]): string[] {
    if (candidates.length <= 1) {
        return candidates;
    }
    const indexed = candidates.map((engine, index) => {
        const health = metrics.getRecentEngineHealth(engine);
        const isDegraded = Boolean(health && health.total >= 2 && health.successRate < 50);
        return {
            engine,
            index,
            isDegraded,
            successRate: health?.successRate ?? 100,
            avgDurationMs: health?.avgDurationMs ?? 0
        };
    });
    indexed.sort((a, b) => {
        if (a.isDegraded !== b.isDegraded) {
            return a.isDegraded ? 1 : -1;
        }
        if (a.isDegraded && b.isDegraded) {
            if (a.successRate !== b.successRate) {
                return b.successRate - a.successRate;
            }
            if (a.avgDurationMs !== b.avgDurationMs) {
                return a.avgDurationMs - b.avgDurationMs;
            }
        }
        return a.index - b.index;
    });
    return indexed.map((item) => item.engine);
}

/**
 * 按查询语言挑选并排序级联补位候选引擎：
 * - 中文查询（≥2 个 CJK 字符）：优先国内综合与技术社区引擎（baidu -> sogou -> bing -> juejin -> csdn -> 海外）
 * - 英文/符号查询（<2 个 CJK 字符）：仅在英文/全球引擎池（bing -> duckduckgo -> brave -> exa -> startpage）内级联。
 *
 * 【刻意设计权衡（勿轻易回退）】：
 * 当用户处于无代理环境、未配置 EXA_API_KEY、发起英文查询且主引擎 bing 结果不足时，
 * EN_CASCADE_PRIORITY 中的海外引擎会因不可达被过滤，此时本函数会返回 `[]`（不再级联），
 * 而**不会**回落到 baidu/csdn/juejin/sogou。
 * 原因：纯英文技术查询回落到国内中文社区引擎会召回大量不相关的中文营销/二手转载帖，
 * 不仅浪费 3~10s 级联预算，还会严重稀释已有的少量英文高质量结果。
 * （注：仅当调用方在合成单测中注入的自定义 engineMap 完全未注册任何全球引擎时，才回退遍历 SUPPORTED_SEARCH_ENGINES。）
 */
export function pickCascadeCandidates(
    cleanQuery: string,
    usedEngines: Set<string>,
    engineMap: SearchEngineExecutorMap,
    hasExaKey: boolean,
    allowedEngines?: string[]
): string[] {
    const isEligible = (engine: string): boolean => (
        !usedEngines.has(engine)
        && typeof engineMap[engine] === 'function'
        && (!allowedEngines || allowedEngines.length === 0 || allowedEngines.includes(engine))
        && !isEngineCircuitOpen(engine)
        && !isKnownUnreachableOverseasEngine(engine)
        && (engine !== 'exa' || hasExaKey)
    );

    const cjkCount = (cleanQuery.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjkCount >= 2) {
        return sortCandidatesByRecentHealth(ZH_CASCADE_PRIORITY.filter(isEligible));
    }

    const enMatched = EN_CASCADE_PRIORITY.filter(isEligible);
    if (enMatched.length > 0) {
        return sortCandidatesByRecentHealth(enMatched);
    }

    // 刻意权衡：只要 engineMap 注册过任一全球引擎（真实运行环境），英文查询在无可用全球候选时直接返回 []，绝不跨语言回落中文引擎
    const hasAnyGlobalEngineRegistered = EN_CASCADE_PRIORITY.some((engine) =>
        typeof engineMap[engine] === 'function'
        && (!allowedEngines || allowedEngines.length === 0 || allowedEngines.includes(engine))
    );
    if (hasAnyGlobalEngineRegistered) {
        return [];
    }

    return sortCandidatesByRecentHealth(SUPPORTED_SEARCH_ENGINES.filter(isEligible));
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
        perEngineTimeoutMs,
        allowedEngines,
        siteDomains
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
    const initialCandidates = pickCascadeCandidates(cleanQuery, usedEngines, engineMap, hasExaKey, allowedEngines);

    let cascadeBatches = 0;
    let remainingCandidates = [...initialCandidates];
    while (
        remainingCandidates.length > 0
        && countUsableResults(merged, cleanQuery) < minResults
        && cascadeBatches < MAX_CASCADE_BATCHES
    ) {
        // 每轮批次启动前重新过滤：若上一批刚探测出海外网络不可达（写入 overseasProbe 缓存）或触发了熔断器，
        // 立即剔除后续同属海外/已熔断的候选引擎（如 startpage），避免再白白挂满一个超时周期
        remainingCandidates = remainingCandidates.filter(
            (engine) => !isEngineCircuitOpen(engine) && !isKnownUnreachableOverseasEngine(engine)
        );
        if (remainingCandidates.length === 0) {
            break;
        }
        const remaining = deadlineAt - Date.now();
        if (remaining < MIN_CASCADE_BATCH_BUDGET_MS) {
            break;
        }
        cascadeBatches += 1;
        const batch = remainingCandidates.slice(0, CASCADE_BATCH_SIZE);
        remainingCandidates = remainingCandidates.slice(CASCADE_BATCH_SIZE);
        const gap = minResults - countUsableResults(merged, cleanQuery);

        const batchControllers = new Map<string, AbortController>();
        let batchSatisfied = false;
        const batchStartLength = merged.length;
        let batchAllReturnedNonEmpty = true;
        let batchNewResults = 0;

        const runCandidate = (candidate: string): Promise<{ results: SearchResult[]; timedOut: boolean; cancelledBySatisfaction?: boolean }> => new Promise((resolve, reject) => {
            let done = false;
            const cascadeStartedAt = Date.now();
            const wait = Math.max(0, Math.min(remaining, perEngineTimeoutMs));
            const controller = new AbortController();
            batchControllers.set(candidate, controller);
            let cascadeTimedOut = false;
            const timer = setTimeout(() => {
                done = true;
                cascadeTimedOut = true;
                controller.abort(new AppError({
                    code: 'network_timeout',
                    retryable: true,
                    engine: candidate,
                    message: `Engine timeout after ${wait}ms`
                }));
                cascadeMetrics.push({ engine: candidate, ms: wait, count: 0, error: `timeout after ${wait}ms`, timedOut: true });
                metrics.recordEngineSearch(candidate, wait, false);
                cascadeFailures.push({
                    engine: candidate,
                    code: 'engine_error',
                    errorCode: 'network_timeout',
                    retryable: true,
                    message: buildHintedMessage(candidate, `Engine timeout after ${wait}ms (no response in time)`)
                });
                resolve({ results: [], timedOut: true });
            }, wait);

            (async () => {
                const results = await withEngineConcurrencySlot(candidate, deadlineAt, controller.signal, () =>
                    engineMap[candidate]!(searchQuery, gap, {
                        searchMode: effectiveSearchMode,
                        signal: controller.signal
                    })
                );
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    if (batchSatisfied && controller.signal.aborted) {
                        resolve({ results: [], timedOut: false, cancelledBySatisfaction: true });
                        return;
                    }
                    if (!cascadeTimedOut) {
                        cascadeMetrics.push({ engine: candidate, ms: Date.now() - cascadeStartedAt, count: results.length });
                        metrics.recordEngineSearch(candidate, Date.now() - cascadeStartedAt, results.length > 0);
                    }
                    if (results.length > 0) {
                        const before = merged.length;
                        cascadedEngines.push(candidate);
                        engineResults.push(results);
                        merged = mergeSearchResults(engineResults)
                            .filter((result) => !isPlaceholderResult(result))
                            .filter((result) => matchesSiteDomains(result.url, siteDomains ?? []));
                        batchNewResults += merged.length - before;
                        // 同批内一旦某个候选引擎已凑够 minResults 可用结果，立即用 cascade_aborted 哨兵取消同批仍在等待的其他慢引擎
                        if (countUsableResults(merged, cleanQuery) >= minResults) {
                            batchSatisfied = true;
                            for (const [otherCandidate, otherController] of batchControllers.entries()) {
                                if (otherCandidate !== candidate && !otherController.signal.aborted) {
                                    otherController.abort(new AppError({
                                        code: 'cascade_aborted',
                                        retryable: false,
                                        engine: otherCandidate,
                                        message: 'Cascade target already satisfied by sibling engine'
                                    }));
                                }
                            }
                        }
                    }
                    resolve({ results, timedOut: false });
                }
            })().catch((error: unknown) => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    if (batchSatisfied && controller.signal.aborted) {
                        resolve({ results: [], timedOut: false, cancelledBySatisfaction: true });
                        return;
                    }
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

        const settled = await Promise.allSettled(batch.map((candidate) => runCandidate(candidate)));

        for (let index = 0; index < settled.length; index += 1) {
            const candidate = batch[index];
            const outcome = settled[index];
            if (!candidate || !outcome) {
                continue;
            }
            if (outcome.status === 'fulfilled') {
                if (outcome.value.cancelledBySatisfaction) {
                    continue;
                }
                if (outcome.value.timedOut) {
                    batchAllReturnedNonEmpty = false;
                    continue;
                }
                if (outcome.value.results.length === 0) {
                    batchAllReturnedNonEmpty = false;
                    cascadeFailures.push({
                        engine: candidate,
                        code: 'no_results',
                        retryable: false,
                        message: 'Engine returned no results for the cascaded quota'
                    });
                }
            } else {
                batchAllReturnedNonEmpty = false;
                const errorCode = extractErrorCode(outcome.reason);
                const status = extractErrorStatus(outcome.reason);
                const details = extractErrorDetails(outcome.reason);
                const hint = isAppError(outcome.reason) ? outcome.reason.hint : undefined;
                cascadeFailures.push({
                    engine: candidate,
                    code: 'engine_error',
                    ...(errorCode ? { errorCode } : {}),
                    ...(status !== undefined ? { status } : {}),
                    ...(details ? { details } : {}),
                    ...(hint ? { hint } : {}),
                    retryable: isRetryableEngineError(outcome.reason),
                    message: buildHintedMessage(candidate, outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason), hint)
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
