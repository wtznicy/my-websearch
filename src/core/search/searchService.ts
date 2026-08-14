import { SearchResult } from '../../types.js';
import { AppConfig } from '../../config.js';
import { distributeLimit, SUPPORTED_SEARCH_ENGINES } from './searchEngines.js';
import { sleep } from '../../utils/timing.js';

export type SearchExecutionContext = {
    searchMode?: AppConfig['searchMode'];
};

export type SearchEngineExecutor = (query: string, limit: number, context?: SearchExecutionContext) => Promise<SearchResult[]>;
export type SearchEngineExecutorMap = Partial<Record<string, SearchEngineExecutor>>;

export type SearchExecutionFailure = {
    engine: string;
    code: 'engine_error' | 'unsupported_engine' | 'no_results';
    message: string;
};

export type SearchExecutionResult = {
    query: string;
    engines: string[];
    totalResults: number;
    results: SearchResult[];
    partialFailures: SearchExecutionFailure[];
    /** 级联补位实际成功的引擎（仅当 minResults 触发时出现） */
    cascadedEngines?: string[];
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
 * 兼容常见的追踪参数（utm_*、fbclid 等）造成的"同页不同 URL"。
 */
export function normalizeResultUrl(url: string): string {
    try {
        const parsed = new URL(url);
        // 去掉锚点与常见追踪参数后再比较
        parsed.hash = '';
        for (const key of [...parsed.searchParams.keys()]) {
            if (key.startsWith('utm_') || key === 'fbclid' || key === 'gclid' || key === 'ref' || key === 'spm') {
                parsed.searchParams.delete(key);
            }
        }
        // 等价 URL 归一化：统一 https、去 www. 前缀、根路径去掉尾斜杠，
        // 避免 http/https、www 前缀、尾斜杠差异让同一页被当成两条结果
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            parsed.protocol = 'https:';
            const hostname = parsed.hostname.toLowerCase();
            parsed.hostname = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
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
function isPlaceholderResult(result: SearchResult): boolean {
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
 * - 同分时保留先到的引擎结果（保持原始顺序稳定）
 * - 去重结果保留先到的引擎（source / engine 字段），不合并多引擎来源
 */
export function mergeSearchResults(engineResults: SearchResult[][]): SearchResult[] {
    const seen = new Map<string, { result: SearchResult; hits: number; order: number }>();
    let order = 0;

    for (const results of engineResults) {
        for (const result of results) {
            const key = normalizeResultUrl(result.url);
            const existing = seen.get(key);
            if (existing) {
                existing.hits += 1;
            } else {
                seen.set(key, { result, hits: 1, order });
                order += 1;
            }
        }
    }

    return [...seen.values()]
        .sort((a, b) => b.hits - a.hits || a.order - b.order)
        .map(({ result }) => result);
}

// ---------------------------------------------------------------------------
// TTL 缓存
// ---------------------------------------------------------------------------

/**
 * limit 档位归一化：limit=5 与 limit=10 的同一查询共享缓存。
 * LLM 客户端常随机传 limit，原始 limit 作键会让缓存几乎永远 miss。
 * >10 不归一化（保留原值），避免缓存不足量的结果（如 limit=50 只拿到 20 条）。
 */
function normalizeLimitBucket(limit: number): number {
    if (limit <= 5) {
        return 5;
    }
    if (limit <= 10) {
        return 10;
    }
    return limit;
}

type CacheEntry = {
    value: SearchExecutionResult;
    expiresAt: number;
};

/**
 * 简单的内存 TTL 缓存。键为 query+engines+limit+searchMode 的组合。
 * 默认 TTL 5 分钟（context7 官方 best practice 也建议对文档类响应做小时级缓存；
 * 搜索结果的时效性更高，5 分钟是一个平衡点）。
 */
export class SearchTtlCache {
    private cache = new Map<string, CacheEntry>();
    private readonly ttlMs: number;
    private readonly maxEntries: number;

    constructor(ttlMs: number = 5 * 60 * 1000, maxEntries: number = 200) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
    }

    private buildKey(input: SearchExecutionInput): string {
        // searchMode 用规范化后的值（'auto' 等价于 undefined），保证两种写法共享缓存
        const normalizedSearchMode = resolveSearchModeOverride(input.searchMode);
        return JSON.stringify({
            q: input.query.trim().toLowerCase(),
            e: [...input.engines].sort(),
            l: normalizeLimitBucket(input.limit),
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
        // limit 归一化后缓存可能比请求多（如 limit=5 命中 limit=10 的档位）：按请求 limit 截断，保持语义
        if (entry.value.results.length > input.limit) {
            return {
                ...entry.value,
                totalResults: input.limit,
                results: entry.value.results.slice(0, input.limit)
            };
        }
        return entry.value;
    }

    set(input: SearchExecutionInput, value: SearchExecutionResult): void {
        // 淘汰过期条目
        const now = Date.now();
        for (const [key, entry] of this.cache) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
            }
        }
        // 超过容量时删除最老的（Map 保持插入序，删第一个即可）
        while (this.cache.size >= this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.cache.delete(oldestKey);
        }
        this.cache.set(this.buildKey(input), { value, expiresAt: now + this.ttlMs });
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

/** 4xx（除 429 限流）不重试——参数/请求本身有问题，重试只会白耗时间；5xx、网络/超时错误重试。
 * 引擎可显式标记 error.retryable = false（如"未配置 API key""海外引擎无代理不可达"等确定性错误），
 * 多引擎搜索时让该引擎立即失败，不占用重试退避时间、不影响其他引擎。 */
function isRetryableEngineError(error: unknown): boolean {
    if ((error as any)?.retryable === false) {
        return false;
    }
    const status = (error as any)?.response?.status;
    if (typeof status === 'number') {
        return status === 429 || status >= 500;
    }
    return true;
}

/** 429 用更长退避并尊重 Retry-After；其他错误用短退避；都带少量 jitter 避免并发重试再碰撞 */
function computeRetryBackoff(error: unknown, attempt: number): number {
    const status = (error as any)?.response?.status;
    if (status === 429) {
        const retryAfter = Number((error as any)?.response?.headers?.['retry-after']);
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            return retryAfter * 1000;
        }
        return 1000 * (2 ** attempt) + Math.random() * 250;
    }
    return 300 * (2 ** attempt) + Math.random() * 100;
}

/**
 * 给引擎失败消息附加可执行的 Hint，帮助 LLM/用户决定下一步
 * （换引擎、稍后重试等），而不是看到裸错误就放弃。
 */
function buildHintedMessage(engine: string, message: string): string {
    const hint = '可换用其他引擎（engines 参数）或稍后重试';
    if (message.includes('Hint:')) {
        return message;
    }
    return `${message} | Hint: 引擎 ${engine} 暂不可用，${hint}`;
}

// 搜索级总时间预算：超过后未完成的引擎按超时处理，避免单个慢引擎（含重试）拖垮整次搜索
export const SEARCH_DEADLINE_MS = 30000;

export function createSearchService(engineMap: SearchEngineExecutorMap, cache?: SearchTtlCache) {
    const ttlCache = cache ?? new SearchTtlCache();

    return {
        async execute({ query, engines, limit, searchMode, minResults }: SearchExecutionInput): Promise<SearchExecutionResult> {
            const cleanQuery = query.trim();
            if (!cleanQuery) {
                throw new Error('Query string cannot be empty');
            }

            // 缓存命中直接返回
            const cached = ttlCache.get({ query: cleanQuery, engines, limit, searchMode, minResults });
            if (cached) {
                return cached;
            }

            const limits = distributeLimit(limit, engines.length);
            const partialFailures: SearchExecutionFailure[] = [];
            const effectiveSearchMode = resolveSearchModeOverride(searchMode);

            // 搜索级总时间预算：到点后未完成的引擎按超时处理，避免单个慢引擎拖垮整次搜索
            const deadlineMs = SEARCH_DEADLINE_MS;
            const deadlineAt = Date.now() + deadlineMs;

            const tasks = engines.map(async (engine, index) => {
                const executor = engineMap[engine];
                const engineLimit = limits[index];

                if (!executor) {
                    partialFailures.push({
                        engine,
                        code: 'unsupported_engine',
                        message: `Unsupported search engine: ${engine}`
                    });
                    return [];
                }

                // 配额为 0 时跳过调用（引擎未被分配结果配额，直接视为"未调用"，不进 partialFailures）
                if (engineLimit <= 0) {
                    return [];
                }

                // 引擎请求错峰：按索引交错启动，避免多引擎同时突发请求触发限流
                if (index > 0) {
                    await sleep(index * 150);
                }

                // 失败指数退避：最多重试 2 次（4xx 除 429 外不重试）
                let lastError: unknown;
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    try {
                        const results = await executor(cleanQuery, engineLimit, { searchMode: effectiveSearchMode });
                        if (attempt > 0) {
                            console.error(`✅ Engine ${engine} recovered after ${attempt} retries`);
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

                partialFailures.push({
                    engine,
                    code: 'engine_error',
                    message: buildHintedMessage(engine, lastError instanceof Error ? lastError.message : String(lastError))
                });
                return [];
            });

            // 每个引擎任务包一层 deadline：到点未完成按超时处理（记录 partialFailure，不阻塞整体）。
            // 注意：task 提前完成时必须 clearTimeout，否则 30s 的 ref'd timer 会阻止 Node 进程退出
            // （CLI 一次性命令会白白多挂近 30 秒），同时也能避免 timer 回调对已 settle 的 race 做无用功。
            const engineResults = await Promise.all(tasks.map((task, index) => {
                const remaining = deadlineAt - Date.now();
                const wait = remaining > 0 ? remaining : 0;
                return new Promise<SearchResult[]>((resolve) => {
                    let done = false;
                    const timer = setTimeout(() => {
                        done = true;
                        if (!partialFailures.some((failure) => failure.engine === engines[index])) {
                            partialFailures.push({
                                engine: engines[index],
                                code: 'engine_error',
                                message: buildHintedMessage(engines[index], `Search deadline exceeded (${deadlineMs}ms total budget)`)
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
            let merged = mergeSearchResults(engineResults)
                .filter((result) => !isPlaceholderResult(result))
                .slice(0, limit);

            // 配额 >0 但引擎返回 0 条时，记录为可见的部分失败，便于 agent 区分
            // "该引擎没结果"（no_results，属正常空结果）与 "该引擎没被调用"（配额 0 的情况）。
            // 注意：不能把正常空结果报成 engine_error——冷门查询所有引擎都 0 条时会刷一墙误导性"故障"。
            engines.forEach((engine, index) => {
                const executor = engineMap[engine];
                if (executor && limits[index] > 0 && engineResults[index].length === 0) {
                    if (!partialFailures.some((failure) => failure.engine === engine)) {
                        partialFailures.push({
                            engine,
                            code: 'no_results',
                            message: 'Engine returned no results for the allocated quota'
                        });
                    }
                }
            });

            // 级联补位：minResults 已设且结果不足时，用未请求的可用引擎补跑直到凑足。
            // 候选按批次并行（每批最多 CASCADE_BATCH_SIZE 个），避免逐串行累积延迟。
            // 每批开始前重算 deadline 余量：剩余预算不足一个批次的最坏成本时停止，
            // 避免海外引擎 15s 超时把总时长拉成多倍 deadline；全部候选返回但去重后
            // 0 新增时也立即停止（结果集已收敛，继续尝试没有意义）。
            // 默认不启用（minResults 为 0）。
            const cascadedEngines: string[] = [];
            const CASCADE_BATCH_SIZE = 2;
            const MIN_CASCADE_BATCH_BUDGET_MS = 3000;
            if (minResults && minResults > merged.length) {
                const usedEngines = new Set(engines);
                const candidates = SUPPORTED_SEARCH_ENGINES.filter(
                    (engine) => !usedEngines.has(engine) && typeof engineMap[engine] === 'function'
                );
                for (let cursor = 0; cursor < candidates.length && merged.length < minResults; cursor += CASCADE_BATCH_SIZE) {
                    const remaining = deadlineAt - Date.now();
                    if (remaining < MIN_CASCADE_BATCH_BUDGET_MS) {
                        break;
                    }
                    const batch = candidates.slice(cursor, cursor + CASCADE_BATCH_SIZE);
                    const gap = minResults - merged.length;
                    // 与引擎 deadline 同理：候选提前完成时必须 clearTimeout，否则泄漏的 30s timer 延迟 Node 进程退出
                    const runCandidate = (candidate: string): Promise<SearchResult[]> => new Promise((resolve, reject) => {
                        let done = false;
                        const timer = setTimeout(() => {
                            done = true;
                            partialFailures.push({
                                engine: candidate,
                                code: 'engine_error',
                                message: buildHintedMessage(candidate, `Search deadline exceeded (${deadlineMs}ms total budget)`)
                            });
                            resolve([]);
                        }, remaining);

                        (async () => {
                            const results = await engineMap[candidate]!(cleanQuery, gap, { searchMode: effectiveSearchMode });
                            if (!done) {
                                done = true;
                                clearTimeout(timer);
                                resolve(results);
                            }
                        })().catch((error) => {
                            if (!done) {
                                done = true;
                                clearTimeout(timer);
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
                        if (outcome.status === 'fulfilled' && outcome.value.length > 0) {
                            const before = merged.length;
                            cascadedEngines.push(candidate);
                            engineResults.push(outcome.value);
                            merged = mergeSearchResults(engineResults)
                                .filter((result) => !isPlaceholderResult(result))
                                .slice(0, limit);
                            batchNewResults += merged.length - before;
                        } else {
                            batchAllReturnedNonEmpty = false;
                            if (outcome.status === 'fulfilled') {
                                partialFailures.push({
                                    engine: candidate,
                                    code: 'no_results',
                                    message: 'Engine returned no results for the cascaded quota'
                                });
                            } else {
                                partialFailures.push({
                                    engine: candidate,
                                    code: 'engine_error',
                                    message: buildHintedMessage(candidate, outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason))
                                });
                            }
                        }
                    }
                    // 所有候选都返回了结果但去重后 0 新增：继续尝试其他引擎只会重复同样的事
                    if (batchAllReturnedNonEmpty && batchNewResults === 0 && merged.length === batchStartLength) {
                        break;
                    }
                }
            }

            const result: SearchExecutionResult = {
                query: cleanQuery,
                engines,
                totalResults: merged.length,
                results: merged,
                partialFailures,
                ...(cascadedEngines.length > 0 ? { cascadedEngines } : {})
            };

            // 失败/降级结果不缓存：有 partialFailures 或零结果时，下次相同查询应重试，
            // 避免引擎临时故障被钉死在 TTL 内。
            if (partialFailures.length === 0 && merged.length > 0) {
                ttlCache.set({ query: cleanQuery, engines, limit, searchMode, minResults }, result);
            }

            return result;
        },

        /** 清空搜索 TTL 缓存（引擎刚恢复/反爬页面过期时手动强制重查） */
        clearCache(): void {
            ttlCache.clear();
        },

        get cacheSize(): number {
            return ttlCache.size;
        }
    };
}
