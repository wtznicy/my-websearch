import { SearchResult } from '../../types.js';
import { AppConfig, config } from '../../config.js';
import { SUPPORTED_SEARCH_ENGINES } from './searchEngines.js';
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
import { isDateWithinTimeRange, TimeRange } from '../../utils/dateNormalizer.js';
import { derivePublishedAt } from './dateExtraction.js';
import { runInlineDiagnostics, InlineDiagnostics } from '../../utils/networkDiagnostics.js';
import { RequestContext, createRequestContext } from '../requestContext.js';
import { Semaphore } from '../../utils/concurrency.js';
import type {
    SearchExecutionContext,
    SearchEngineExecutor,
    SearchEngineExecutorMap,
    SearchExecutionFailure
} from './searchTypes.js';
import { normalizeResultUrl, isPlaceholderResult, mergeSearchResults } from './mergeResults.js';
import { normalizeSearchResult } from './normalizeResult.js';

export { Semaphore, normalizeResultUrl, isPlaceholderResult, mergeSearchResults };
export type { SearchExecutionContext, SearchEngineExecutor, SearchEngineExecutorMap, SearchExecutionFailure };

export {
    isRetryableEngineError,
    computeRetryBackoff,
    buildHintedMessage,
    truncateMetricError,
    extractSiteDomains,
    matchesSiteDomains
};

// 全局并发限制（0 = 不限制）
let globalSemaphore: Semaphore | null = null;

export function configureGlobalConcurrencyLimit(maxConcurrent: number, maxQueueSize?: number): void {
    globalSemaphore = maxConcurrent > 0 ? new Semaphore(maxConcurrent, maxQueueSize) : null;
}

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
    /** 警告信息集合（如 timeRange 过滤导致的部分剔除、引擎降级等） */
    warnings?: string[];
    /** 时间过滤降级指示：'partial' 表示部分结果因无日期字段而被剔除 */
    filterFallback?: 'partial';
    /** 失败时内联诊断信息（proxy、dns、suggestion） */
    diagnostics?: InlineDiagnostics;
};

export type SearchExecutionInput = {
    query: string;
    engines: string[];
    limit: number;
    searchMode?: AppConfig['searchMode'];
    /** 当结果数低于此值时，自动用未请求的可用引擎补跑以凑足（默认 0 = 不启用） */
    minResults?: number;
    /** 时间范围过滤（day|week|month|year） */
    timeRange?: TimeRange;
    /** 限制特定域名过滤（支持数组或单个字符串） */
    site?: string[] | string;
    /** 显式指定的引擎列表（用于约束级联补位范围） */
    requestedEngines?: string[];
    /** 可选取消信号：客户端取消/超时时中止在途引擎请求 */
    signal?: AbortSignal;
    /** 请求上下文（包含 traceId, deadlineAt, warnings 收集器） */
    requestContext?: RequestContext;
};

function resolveSearchModeOverride(searchMode: AppConfig['searchMode'] | undefined): AppConfig['searchMode'] | undefined {
    // Agent 显式传 searchMode=auto 时，应与不传参数一致，优先使用环境变量值。不能优先使用HTTP请求，因为它会导致Bing返回垃圾结果。
    return searchMode === 'auto' ? undefined : searchMode;
}

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
            // P0-3：requestedEngines 决定级联候选集合，语义不同不能共用缓存
            re: [...(input.requestedEngines ?? [])].sort(),
            l: normalizeLimitBucket(input.limit),
            m: normalizedSearchMode,
            r: input.minResults ?? 0,
            t: input.timeRange,
            s: Array.isArray(input.site) ? [...input.site].sort() : input.site
        });
    }

    buildInflightKey(input: SearchExecutionInput): string {
        const normalizedSearchMode = resolveSearchModeOverride(input.searchMode);
        return JSON.stringify({
            q: input.query.trim().toLowerCase(),
            e: [...input.engines].sort(),
            re: [...(input.requestedEngines ?? [])].sort(),
            // 与 buildKey 使用同一分桶，否则 limit=3/5 落同一缓存桶却无法合并单飞
            l: normalizeLimitBucket(input.limit),
            m: normalizedSearchMode,
            r: input.minResults ?? 0,
            t: input.timeRange,
            s: Array.isArray(input.site) ? [...input.site].sort() : input.site
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
        // LRU touch: 将命中条目移到 Map 尾部，确保真正的 LRU 淘汰序（P2-9）
        this.cache.delete(key);
        this.cache.set(key, entry);

        if (entry.value.results.length > input.limit) {
            const truncatedResults = entry.value.results.slice(0, input.limit).map((r) => ({ ...r }));
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
        return {
            ...entry.value,
            results: entry.value.results.map((r) => ({ ...r }))
        };
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
        // 深拷贝 results，防止外部后续原地修改（如 fetchTop 注入 fullContent）污染缓存对象（P1-2）
        const clonedValue: SearchExecutionResult = {
            ...value,
            results: value.results.map((r) => ({ ...r }))
        };
        this.cache.set(key, {
            value: clonedValue,
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
        async execute({ query, engines, limit, searchMode, minResults, timeRange, site, requestedEngines, signal, requestContext }: SearchExecutionInput): Promise<SearchExecutionResult> {
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
            const cacheInput: SearchExecutionInput = { query: searchQuery, engines, limit, searchMode, minResults, timeRange, site, requestedEngines };

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
                // 单飞合并（single-flight）：共享在途请求结果，不计入真实缓存命中（P2-9）
                const shared = await existingInflight;
                return {
                    ...shared,
                    results: shared.results.map((r) => ({ ...r })),
                    partialFailures: [...shared.partialFailures]
                };
            }

            metrics.recordCacheMiss();

            const runPromise = (async (): Promise<SearchExecutionResult> => {
                const deadlineMs = appConfig.searchDeadlineMs;
                const rc = requestContext ?? createRequestContext({ signal, timeoutMs: deadlineMs });
                const deadlineAt = rc.deadlineAt ?? (Date.now() + deadlineMs);
                const effectiveSignal = rc.signal ?? signal;

                if (globalSemaphore) {
                    await globalSemaphore.acquire(deadlineAt, effectiveSignal);
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
                                message: `Engine circuit open (recent rate-limit / anti-bot response: 429, 202 or bot_challenge; ~${Math.ceil(getEngineCircuitRemainingMs(engine) / 1000)}s cooldown left) — quota reallocated to other engines`
                            });
                        }
                    }

                    // 每个引擎都按完整 limit 请求（上限 10，避免深分页），合并后统一去重再截断。
                    // 之前用 distributeLimit 把 limit 切成 n 份：limit=5、3 个引擎 → 每引擎 2 条，
                    // 任何单个快引擎都凑不够 minResults，早退永远不触发、级联池被全量炸出来
                    // （实测 auto 中文 17.3s，其中 bing 一个引擎就 13.8s）。
                    const perEngineLimit = Math.min(limit, 10);
                    const limits = executableEngines.map(() => perEngineLimit);
                    const effectiveSearchMode = resolveSearchModeOverride(searchMode);

                    const extractedSites = extractSiteDomains(cleanQuery);
                    const explicitSites = Array.isArray(site) ? site : (site ? [site] : []);
                    const siteDomains = [...new Set([...extractedSites, ...explicitSites.map((s) => s.trim().toLowerCase())])].filter(Boolean);

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
                        perEngineTimeoutMs,
                        // 结果足够即提前返回（给慢引擎 800ms 宽限）。
                        // minResults 未显式给出时用 limit 本身作为达标线，而不是「所有引擎配额之和」
                        satisfiedResults: minResults && minResults > 0 ? minResults : limit,
                        // P1-10：早退计数必须用「过滤后的净结果」，与最终合并口径一致
                        countableResult: (item) => !isPlaceholderResult(item) && matchesSiteDomains(item.url, siteDomains),
                        signal: effectiveSignal,
                        timeRange,
                        site: siteDomains,
                        requestContext: rc
                    });

                    const allFailures: SearchExecutionFailure[] = [...initialFailures, ...primary.partialFailures];
                    const allMetrics = [...primary.engineMetrics];

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
                        requestedEngines,
                        engineMap,
                        effectiveSearchMode,
                        deadlineAt,
                        perEngineTimeoutMs,
                        // 显式点名引擎时，级联只能在点名的集合内补位；否则会悄悄换成用户没选的引擎
                        // （例如只指定 github，却在 DDG 挂死时返回 bing 的结果）
                        allowedEngines: requestedEngines && requestedEngines.length > 0
                            ? requestedEngines.filter((engine) => appConfig.allowedSearchEngines.length === 0 || appConfig.allowedSearchEngines.includes(engine))
                            : appConfig.allowedSearchEngines,
                        siteDomains,
                        signal: effectiveSignal,
                        timeRange,
                        requestContext: rc
                    });

                    merged = cascade.merged.filter((result) => matchesSiteDomains(result.url, siteDomains));
                    allFailures.push(...cascade.cascadeFailures);
                    allMetrics.push(...cascade.cascadeMetrics);

                    // 管道第 3 阶段：全局重排与截断；剥离内部 rankBoost，避免泄漏到公共 JSON。
                    // P2-15：所有引擎结果先过统一出口（URL 协议校验 / description 截断 / source 补全），
                    // 保证下游时间过滤、去重与 canary 断言面一致。
                    merged = rankSearchResults(merged, cleanQuery, { authorityDomains: appConfig.authorityDomains })
                        .map((result) => {
                            const cleaned = { ...result };
                            delete cleaned.rankBoost;
                            return cleaned;
                        })
                        .map((result) => normalizeSearchResult(result))
                        .filter((result): result is SearchResult => result !== null)
                        .slice(0, limit);

                    // 日期归一化（publishedAt）与 timeRange 过滤
                    const warnings: string[] = [];
                    let filterFallback: 'partial' | undefined;

                    // 日期抽取：引擎字段 → 标题 → 摘要 → URL（纯本地，不发任何网络请求）
                    for (const item of merged) {
                        if (!item.publishedAt) {
                            item.publishedAt = derivePublishedAt({
                                rawDate: item.date,
                                title: item.title,
                                description: item.description,
                                url: item.url
                            });
                        }
                    }

                    if (timeRange) {
                        const beforeCount = merged.length;
                        // 只丢弃「日期明确超出范围」的结果；**日期缺失的保留**。
                        // 之前把 missing 和 out-of-range 合并处理：搜索结果页的 HTML 通常不暴露发布时间，
                        // 于是 bing/baidu/sogou 在 timeRange 下恒定返回 0 条（引擎已在服务端过滤过一遍）。
                        const filtered = merged.filter((item) =>
                            !item.publishedAt || isDateWithinTimeRange(item.publishedAt, timeRange));
                        const droppedCount = beforeCount - filtered.length;
                        const unknownDateCount = filtered.filter((item) => !item.publishedAt).length;
                        if (droppedCount > 0) {
                            filterFallback = 'partial';
                            warnings.push(`Under timeRange='${timeRange}', ${droppedCount} results were dropped because their publication date was outside the range.`);
                            metrics.recordTimeRangeAttempt(true);
                        } else {
                            metrics.recordTimeRangeAttempt(false);
                        }
                        if (unknownDateCount > 0) {
                            warnings.push(`${unknownDateCount} results have no parseable publication date and were kept, since the engine already applied its own time filter.`);
                        }
                        merged = filtered;
                    }

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

                    let diagnostics: InlineDiagnostics | undefined;
                    if (outcome === 'failed') {
                        try {
                            diagnostics = await runInlineDiagnostics();
                        } catch {
                            // ignore diagnostics error
                        }
                    }

                    // 代理不可达但直连可用 → 给一条可行动的警告，而不是让用户盯着超时发呆
                    if (appConfig.useProxy) {
                        const proxyFailures = allFailures.filter((failure) => failure.errorCode === 'proxy_unreachable');
                        if (proxyFailures.length > 0 && merged.length > 0) {
                            warnings.push(
                                `Configured proxy ${appConfig.proxyUrl} looks unreachable: ${proxyFailures.length} proxied engine(s) failed to connect while direct engines returned results. `
                                + 'Check the proxy section of ~/.my-websearch/config.json, or set USE_PROXY=false to go direct. '
                                + `/ 配置的代理 ${appConfig.proxyUrl} 可能不可达：${proxyFailures.length} 个走代理的引擎连接失败，直连引擎正常。请检查配置或设置 USE_PROXY=false 直连。`
                            );
                        }
                    }

                    const combinedWarnings = [...new Set([...rc.warnings, ...warnings])];

                    const result: SearchExecutionResult = {
                        query: cleanQuery,
                        engines: executableEngines,
                        totalResults: merged.length,
                        results: merged,
                        partialFailures: allFailures,
                        outcome,
                        retryable,
                        cached: false,
                        ...(combinedWarnings.length > 0 ? { warnings: combinedWarnings } : {}),
                        ...(filterFallback ? { filterFallback } : {}),
                        ...(diagnostics ? { diagnostics } : {}),
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
                    } else if (outcome === 'empty' || outcome === 'ok') {
                        // 空结果短缓存（30s）：避免对明确无结果的相同 query 密集冲击上游（P2-9）
                        ttlCache.set(cacheInput, result, 30 * 1000);
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
