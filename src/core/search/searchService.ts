import { SearchResult } from '../../types.js';
import { AppConfig, config } from '../../config.js';
import { distributeLimit, SUPPORTED_SEARCH_ENGINES } from './searchEngines.js';
import { rankSearchResults } from './resultRanking.js';
import { isEngineCircuitOpen, getEngineCircuitRemainingMs } from './engineCircuitBreaker.js';
import { quoteModelLikeTerms, preprocessSearchQuery } from '../../utils/queryPreprocess.js';
import { extractSiteDomains, matchesSiteDomains } from '../../engines/bing/bing.js';
import { metrics } from '../metrics.js';
import { classifyFailureRetryable, AppError } from '../errors.js';
import {
    executePrimaryEngines,
    isRetryableEngineError,
    computeRetryBackoff,
    buildHintedMessage,
    truncateMetricError
} from './engineExecutor.js';
import { executeCascade } from './cascadeExecutor.js';

export {
    isRetryableEngineError,
    computeRetryBackoff,
    buildHintedMessage,
    truncateMetricError,
    extractSiteDomains,
    matchesSiteDomains
};

// ---------------------------------------------------------------------------
// 简单信号量：限制并发搜索数（支持队列上限、排队超时与 AbortSignal 取消）
// ---------------------------------------------------------------------------

type SemaphoreWaiter = {
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
    cleanupAbort?: () => void;
};

export class Semaphore {
    private permits: number;
    private readonly maxQueueSize: number;
    private waitQueue: SemaphoreWaiter[] = [];

    constructor(permits: number, maxQueueSize = Math.max(16, permits * 4)) {
        this.permits = permits;
        this.maxQueueSize = maxQueueSize;
    }

    async acquire(deadlineAt?: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new AppError({ code: 'aborted', retryable: false, message: 'Aborted while acquiring concurrency slot' });
        }
        if (this.permits > 0) {
            this.permits -= 1;
            return;
        }
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
            throw new AppError({
                code: 'network_timeout',
                retryable: true,
                message: 'Search deadline exhausted before acquiring concurrency slot'
            });
        }
        if (this.waitQueue.length >= this.maxQueueSize) {
            throw new AppError({
                code: 'queue_full',
                retryable: true,
                message: `Search concurrency queue is full (max ${this.maxQueueSize} waiting requests)`
            });
        }

        return new Promise<void>((resolve, reject) => {
            const waiter: SemaphoreWaiter = {
                resolve: () => {
                    if (waiter.timer) {
                        clearTimeout(waiter.timer);
                    }
                    waiter.cleanupAbort?.();
                    resolve();
                },
                reject: (err: Error) => {
                    if (waiter.timer) {
                        clearTimeout(waiter.timer);
                    }
                    waiter.cleanupAbort?.();
                    reject(err);
                }
            };

            if (signal) {
                const onAbort = () => {
                    const idx = this.waitQueue.indexOf(waiter);
                    if (idx !== -1) {
                        this.waitQueue.splice(idx, 1);
                    }
                    waiter.reject(
                        signal.reason instanceof Error
                            ? signal.reason
                            : new AppError({ code: 'aborted', retryable: false, message: 'Aborted while waiting in concurrency queue' })
                    );
                };
                signal.addEventListener('abort', onAbort, { once: true });
                waiter.cleanupAbort = () => signal.removeEventListener('abort', onAbort);
            }

            if (deadlineAt !== undefined) {
                const remainingMs = Math.max(0, deadlineAt - Date.now());
                waiter.timer = setTimeout(() => {
                    const idx = this.waitQueue.indexOf(waiter);
                    if (idx !== -1) {
                        this.waitQueue.splice(idx, 1);
                    }
                    waiter.reject(new AppError({
                        code: 'network_timeout',
                        retryable: true,
                        message: `Search timed out after waiting ${remainingMs}ms in concurrency queue`
                    }));
                }, remainingMs);
            }

            this.waitQueue.push(waiter);
        });
    }

    release(): void {
        const next = this.waitQueue.shift();
        if (next) {
            next.resolve();
        } else {
            this.permits += 1;
        }
    }
}

// 全局并发限制（0 = 不限制）
let globalSemaphore: Semaphore | null = null;

export function configureGlobalConcurrencyLimit(maxConcurrent: number, maxQueueSize?: number): void {
    globalSemaphore = maxConcurrent > 0 ? new Semaphore(maxConcurrent, maxQueueSize) : null;
}

export type SearchExecutionContext = {
    searchMode?: AppConfig['searchMode'];
    signal?: AbortSignal;
};

export type SearchEngineExecutor = (query: string, limit: number, context?: SearchExecutionContext) => Promise<SearchResult[]>;
export type SearchEngineExecutorMap = Partial<Record<string, SearchEngineExecutor>>;

export type SearchExecutionFailure = {
    engine: string;
    code: 'engine_error' | 'unsupported_engine' | 'no_results' | 'circuit_open';
    errorCode?: string;
    status?: number;
    hint?: string;
    details?: Record<string, unknown>;
    message: string;
    retryable?: boolean;
};

export type SearchOutcome = 'ok' | 'degraded' | 'empty' | 'failed';

export interface ComputeSearchOutcomeOptions {
    requestedLimit?: number;
    minResults?: number;
    primaryEngines?: string[];
}

export function computeSearchOutcome(
    totalResults: number,
    partialFailures: SearchExecutionFailure[],
    directAnswer?: string,
    options?: ComputeSearchOutcomeOptions
): { outcome: SearchOutcome; retryable: boolean } {
    const hardFailures = partialFailures.filter((failure) => failure.code !== 'no_results');
    const hasUsablePayload = totalResults > 0 || Boolean(directAnswer && directAnswer.trim().length > 0);
    if (hasUsablePayload) {
        // 1. 无硬性错误（仅有其他引擎的 no_results）→ 整体状态为 ok
        if (hardFailures.length === 0) {
            return {
                outcome: 'ok',
                retryable: false
            };
        }
        // 2. 结果数已满额达到请求的 requestedLimit（刻意拍板设计）：
        //    即使主请求引擎发生超时/反爬硬失败，只要多引擎并跑或级联补位已将调用方请求的条数 100% 补齐，
        //    整体状态即返回 ok（retryable: false），避免调用方/LLM 在结果已满额时继续发起无意义的重试；
        //    具体失败引擎仍完整保留在 partialFailures 字段中供诊断。
        if (options?.requestedLimit !== undefined && options.requestedLimit > 0 && totalResults >= options.requestedLimit) {
            return {
                outcome: 'ok',
                retryable: false
            };
        }
        // 3. 结果数未满 requestedLimit 但已达到 minResults 底线：
        //    此时仅当主请求引擎本身无硬错误（即硬错误仅来自级联额外试探的次要引擎）时才判为 ok；
        //    若主引擎发生了硬错误且结果数未满 requestedLimit（仅靠级联勉强凑够 minResults），仍判为 degraded。
        if (options?.minResults !== undefined && options.minResults > 0 && totalResults >= options.minResults) {
            const primarySet = options.primaryEngines ? new Set(options.primaryEngines) : null;
            const primaryHardFailures = primarySet
                ? hardFailures.filter((failure) => primarySet.has(failure.engine))
                : hardFailures;
            if (primaryHardFailures.length === 0) {
                return {
                    outcome: 'ok',
                    retryable: false
                };
            }
        }
        // 4. 存在硬性引擎错误且结果未满额 → degraded；若硬错误中含可重试错误（如超时），retryable=true 供调用方按需重试补齐
        const retryable = hardFailures.some((failure) => classifyFailureRetryable(failure));
        return {
            outcome: 'degraded',
            retryable
        };
    }

    if (hardFailures.length === 0) {
        return {
            outcome: 'empty',
            retryable: false
        };
    }

    const retryable = hardFailures.some((failure) => classifyFailureRetryable(failure));

    return {
        outcome: 'failed',
        retryable
    };
}

export type SearchExecutionResult = {
    query: string;
    engines: string[];
    totalResults: number;
    results: SearchResult[];
    partialFailures: SearchExecutionFailure[];
    /** 搜索结果状态语义：ok（成功无失败或已满额达标）、degraded（有结果但未满额且部分引擎硬失败）、empty（引擎正常完成但无匹配结果）、failed（所有结果为空且引擎出错） */
    outcome?: SearchOutcome;
    /** 当 outcome === 'failed' 或 'degraded' 时指示是否存在可重试的硬失败 */
    retryable?: boolean;
    /** 是否命中内存 TTL 缓存 */
    cached?: boolean;
    /** 级联补位实际成功的引擎（仅当 minResults 触发时出现） */
    cascadedEngines?: string[];
    /** SERP 首位的直接答案卡片文本（如百度汇率换算/百科摘要卡），LLM 可免抓详情页直接取事实 */
    directAnswer?: string;
    /** 每引擎耗时/结果数/错误（可观测性：一眼区分超时与被拒/限流；error 为截断版，完整消息见 partialFailures）
     *  timedOut=true 表示该引擎触发了单引擎超时上限（结果已被丢弃；ms 为超时上限而非墙钟耗时） */
    engineMetrics?: Array<{ engine: string; ms: number; count: number; error?: string; timedOut?: boolean }>;
};

export type SearchExecutionInput = {
    query: string;
    engines: string[];
    limit: number;
    searchMode?: AppConfig['searchMode'];
    /** 当结果数低于此值时，自动用未请求的可用引擎补跑以凑足（默认 0 = 不启用） */
    minResults?: number;
};

function resolveSearchModeOverride(searchMode: AppConfig['searchMode'] | undefined): AppConfig['searchMode'] | undefined {
    // Agent 显式传 searchMode=auto 时，应与不传参数一致，优先使用环境变量值。不能优先使用HTTP请求，因为它会导致Bing返回垃圾结果。
    return searchMode === 'auto' ? undefined : searchMode;
}

// ---------------------------------------------------------------------------
// 跨引擎结果融合
// ---------------------------------------------------------------------------

/**
 * 计算结果的规范化 URL 键，用于跨引擎去重。
 * 兼容常见的无歧义追踪参数（utm_*、fbclid、gclid、msclkid 等）造成的"同页不同 URL"。
 * 注意：不全局剥离 `ref`（可能是 Git 分支/标签或业务路由参数）。
 */
export function normalizeResultUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        const host = parsed.hostname.toLowerCase();
        const isKnownSpmHost = /(^|\.)(csdn\.net|juejin\.cn|bilibili\.com|aliyun\.com|github\.com|gitee\.com|zhihu\.com)$/i.test(host);
        for (const key of [...parsed.searchParams.keys()]) {
            if (key.startsWith('utm_') || key === 'fbclid' || key === 'gclid' || key === 'msclkid') {
                parsed.searchParams.delete(key);
                continue;
            }
            if (key === 'spm' && isKnownSpmHost) {
                parsed.searchParams.delete(key);
                continue;
            }
            if (key === 'tab' && (host === 'github.com' || host === 'gitee.com')) {
                parsed.searchParams.delete(key);
            }
        }
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            parsed.protocol = 'https:';
            parsed.hostname = host.startsWith('www.') ? host.slice(4) : host;
            if (parsed.pathname === '/') {
                parsed.pathname = '';
            }
        }
        return parsed.toString();
    } catch {
        return url.trim();
    }
}

/**
 * 空描述占位结果：description 无实质内容（空串或纯占位符号 "..." / "…" / "-"）
 * 且 title 过短（<10 字符）时，对 LLM 没有信息量（如 "YouTube" + "..." 这类卡片占位），
 * 属于噪音，融合后过滤掉。
 */
export function isPlaceholderResult(result: SearchResult): boolean {
    const description = (result.description ?? '').trim();
    const hasSubstantiveDescription = description.length > 0 && !/^[\s.…·-]*$/.test(description);
    if (hasSubstantiveDescription) {
        return false;
    }
    const title = (result.title ?? '').trim();
    const hasSubstantiveTitle = title.length > 0 && !/^[\s.…·-]*$/.test(title);
    if (!hasSubstantiveTitle) {
        return true;
    }
    return title.length < 10;
}

/**
 * 跨引擎融合：按规范化 URL 去重，并按"被多少个引擎命中"加权排序。
 * - 命中引擎数越多，排名越靠前（多数引擎认为相关 => 更可信）
 * - 同引擎内的重复 URL 只计一次引擎（engineHits 是跨引擎共识，不是出现次数）
 * - 同分时保留先到的引擎结果（保持原始顺序稳定）
 * - 去重结果保留先到的引擎（source / engine 字段），不合并多引擎来源
 */
export function mergeSearchResults(engineResults: SearchResult[][]): SearchResult[] {
    const seen = new Map<string, { result: SearchResult; engines: Set<string>; order: number }>();
    let order = 0;

    for (const results of engineResults) {
        for (const result of results) {
            const key = normalizeResultUrl(result.url);
            const existing = seen.get(key);
            if (existing) {
                existing.engines.add(result.engine);
            } else {
                seen.set(key, { result, engines: new Set([result.engine]), order });
                order += 1;
            }
        }
    }

    return [...seen.values()]
        .sort((a, b) => b.engines.size - a.engines.size || a.order - b.order)
        .map(({ result, engines }) => (engines.size > 1 ? { ...result, engineHits: engines.size } : result));
}

// ---------------------------------------------------------------------------
// TTL 缓存
// ---------------------------------------------------------------------------

function normalizeLimitBucket(limit: number): number {
    return limit <= 10 ? 10 : limit;
}

export type CacheEntry = {
    value: SearchExecutionResult;
    expiresAt: number;
    /** 写入缓存时的请求 limit，用于判断"缓存是否足以满足当前请求" */
    requestedLimit: number;
};

export class SearchTtlCache {
    private cache = new Map<string, CacheEntry>();
    private defaultTtlMs: number;
    private maxEntries: number;

    constructor(ttlMsOrOptions?: number | { ttlMs?: number; maxEntries?: number }, maxEntries?: number) {
        if (typeof ttlMsOrOptions === 'number') {
            this.defaultTtlMs = ttlMsOrOptions;
            this.maxEntries = maxEntries ?? 200;
        } else {
            this.defaultTtlMs = ttlMsOrOptions?.ttlMs ?? 5 * 60 * 1000;
            this.maxEntries = ttlMsOrOptions?.maxEntries ?? 200;
        }
    }

    private buildKey(input: SearchExecutionInput): string {
        const normalizedSearchMode = resolveSearchModeOverride(input.searchMode);
        return JSON.stringify({
            q: input.query.trim().toLowerCase(),
            e: [...input.engines].sort(),
            l: normalizeLimitBucket(input.limit),
            m: normalizedSearchMode,
            r: input.minResults ?? 0
        });
    }

    buildInflightKey(input: SearchExecutionInput): string {
        const normalizedSearchMode = resolveSearchModeOverride(input.searchMode);
        return JSON.stringify({
            q: input.query.trim().toLowerCase(),
            e: [...input.engines].sort(),
            l: input.limit,
            m: normalizedSearchMode,
            r: input.minResults ?? 0
        });
    }

    get(input: SearchExecutionInput): SearchExecutionResult | undefined {
        const key = this.buildKey(input);
        const entry = this.cache.get(key);
        if (!entry) {
            return undefined;
        }
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }
        if (entry.requestedLimit < input.limit && entry.value.results.length < input.limit) {
            return undefined;
        }
        if (entry.value.results.length > input.limit) {
            const truncatedResults = entry.value.results.slice(0, input.limit);
            const { outcome } = computeSearchOutcome(
                truncatedResults.length,
                entry.value.partialFailures,
                entry.value.directAnswer,
                {
                    requestedLimit: input.limit,
                    minResults: input.minResults,
                    primaryEngines: entry.value.engines
                }
            );
            return {
                ...entry.value,
                totalResults: truncatedResults.length,
                results: truncatedResults,
                outcome
            };
        }
        return entry.value;
    }

    set(input: SearchExecutionInput, value: SearchExecutionResult, ttlMs?: number): void {
        const now = Date.now();
        for (const [key, entry] of this.cache) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
            }
        }
        const key = this.buildKey(input);
        const existing = this.cache.get(key);
        if (existing && existing.requestedLimit > input.limit && existing.expiresAt > now) {
            // 保留更大 requestedLimit 的丰富缓存，不被小 limit 请求冲掉
            return;
        }
        while (this.cache.size >= this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, {
            value,
            expiresAt: now + (ttlMs ?? this.defaultTtlMs),
            requestedLimit: input.limit
        });
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

// 搜索级总时间预算：超过后未完成的引擎按超时处理，避免单个慢引擎（含重试）拖垮整次搜索
export const SEARCH_DEADLINE_MS = config.searchDeadlineMs;

/** 降级结果（存在 partialFailures）的短缓存 TTL：既避免击穿，又不把故障钉太久 */
const DEGRADED_CACHE_TTL_MS = 60 * 1000;

// 查询长度上限：防止超长查询导致搜索引擎请求超时或被封禁
export const MAX_QUERY_LENGTH = 500;

export function createSearchService(
    engineMap: SearchEngineExecutorMap,
    cache?: SearchTtlCache,
    appConfig: AppConfig = config
) {
    const ttlCache = cache ?? new SearchTtlCache();
    // P1-4：并发同参数查询合并（singleflight 去重）：
    // 在第一个请求尚未返回写进 TTL 缓存前，后续相同查询共享同一 in-flight Promise，避免同时打出 N 份上游请求。
    const inflightSearches = new Map<string, Promise<SearchExecutionResult>>();

    return {
        async execute({ query, engines, limit, searchMode, minResults }: SearchExecutionInput): Promise<SearchExecutionResult> {
            const cleanQuery = query.trim();
            if (!cleanQuery) {
                throw new AppError({
                    code: 'invalid_arguments',
                    retryable: false,
                    message: 'Query string cannot be empty'
                });
            }
            if (cleanQuery.length > MAX_QUERY_LENGTH) {
                throw new AppError({
                    code: 'invalid_arguments',
                    retryable: false,
                    message: `Query string too long (${cleanQuery.length} characters, max ${MAX_QUERY_LENGTH})`
                });
            }

            const searchQuery = preprocessSearchQuery(cleanQuery);
            const cacheInput: SearchExecutionInput = { query: searchQuery, engines, limit, searchMode, minResults };

            const cached = ttlCache.get(cacheInput);
            if (cached) {
                metrics.recordCacheHit();
                return {
                    ...cached,
                    cached: true
                };
            }

            const inflightKey = ttlCache.buildInflightKey(cacheInput);
            const existingInflight = inflightSearches.get(inflightKey);
            if (existingInflight) {
                metrics.recordCacheHit();
                const shared = await existingInflight;
                return {
                    ...shared,
                    results: [...shared.results],
                    partialFailures: [...shared.partialFailures]
                };
            }

            metrics.recordCacheMiss();

            const runPromise = (async (): Promise<SearchExecutionResult> => {
                const deadlineMs = appConfig.searchDeadlineMs;
                const deadlineAt = Date.now() + deadlineMs;

                if (globalSemaphore) {
                    await globalSemaphore.acquire(deadlineAt);
                }

                try {
                    const circuitOpenEngines = engines.filter((engine) => isEngineCircuitOpen(engine));
                    const executableEngines = circuitOpenEngines.length > 0 && circuitOpenEngines.length < engines.length
                        ? engines.filter((engine) => !isEngineCircuitOpen(engine))
                        : engines;

                    const initialFailures: SearchExecutionFailure[] = [];
                    for (const engine of circuitOpenEngines) {
                        if (!executableEngines.includes(engine)) {
                            initialFailures.push({
                                engine,
                                code: 'circuit_open',
                                retryable: true,
                                message: `Engine circuit open (recent HTTP 429 rate limiting, ~${Math.ceil(getEngineCircuitRemainingMs(engine) / 1000)}s cooldown left) — quota reallocated to other engines`
                            });
                        }
                    }

                    const limits = distributeLimit(limit, executableEngines.length);
                    const effectiveSearchMode = resolveSearchModeOverride(searchMode);

                    const perEngineTimeoutMs = Math.min(Math.floor(deadlineMs * 0.5), 10000);

                    // 管道第 1 阶段：主引擎并发执行器
                    const primary = await executePrimaryEngines({
                        query: cleanQuery,
                        searchQuery,
                        executableEngines,
                        limits,
                        effectiveSearchMode,
                        engineMap,
                        deadlineAt,
                        perEngineTimeoutMs
                    });

                    const allFailures: SearchExecutionFailure[] = [...initialFailures, ...primary.partialFailures];
                    const allMetrics = [...primary.engineMetrics];
                    const siteDomains = extractSiteDomains(cleanQuery);

                    let merged = mergeSearchResults(primary.engineResults)
                        .filter((result) => !isPlaceholderResult(result))
                        .filter((result) => matchesSiteDomains(result.url, siteDomains));

                    // 管道第 2 阶段：级联补位执行器（结果不足时按批补位）
                    const cascade = await executeCascade({
                        cleanQuery,
                        searchQuery,
                        minResults: minResults ?? 0,
                        initialMerged: merged,
                        initialEngineResults: primary.engineResults,
                        engines,
                        engineMap,
                        effectiveSearchMode,
                        deadlineAt,
                        perEngineTimeoutMs,
                        allowedEngines: appConfig.allowedSearchEngines,
                        siteDomains
                    });

                    merged = cascade.merged.filter((result) => matchesSiteDomains(result.url, siteDomains));
                    allFailures.push(...cascade.cascadeFailures);
                    allMetrics.push(...cascade.cascadeMetrics);

                    // 管道第 3 阶段：全局重排与截断
                    merged = rankSearchResults(merged, cleanQuery, { authorityDomains: appConfig.authorityDomains }).slice(0, limit);

                    const { outcome, retryable } = computeSearchOutcome(
                        merged.length,
                        allFailures,
                        primary.directAnswer,
                        {
                            requestedLimit: limit,
                            minResults,
                            primaryEngines: executableEngines
                        }
                    );

                    const result: SearchExecutionResult = {
                        query: cleanQuery,
                        engines: executableEngines,
                        totalResults: merged.length,
                        results: merged,
                        partialFailures: allFailures,
                        outcome,
                        retryable,
                        cached: false,
                        ...(cascade.cascadedEngines.length > 0 ? { cascadedEngines: cascade.cascadedEngines } : {}),
                        ...(primary.directAnswer ? { directAnswer: primary.directAnswer } : {}),
                        ...(allMetrics.some(Boolean) ? { engineMetrics: allMetrics.filter(Boolean) } : {})
                    };

                    // 管道第 4 阶段：TTL 缓存写入
                    if (merged.length > 0) {
                        const degraded = outcome === 'degraded';
                        ttlCache.set(
                            cacheInput,
                            result,
                            degraded ? DEGRADED_CACHE_TTL_MS : undefined
                        );
                    }

                    return result;
                } finally {
                    if (globalSemaphore) {
                        globalSemaphore.release();
                    }
                }
            })().finally(() => {
                inflightSearches.delete(inflightKey);
            });

            inflightSearches.set(inflightKey, runPromise);
            return runPromise;
        },

        clearCache(): void {
            ttlCache.clear();
        },

        get cacheSize(): number {
            return ttlCache.size;
        }
    };
}
