import { SearchResult } from '../../types.js';
import { AppConfig } from '../../config.js';
import { distributeLimit, SUPPORTED_SEARCH_ENGINES } from './searchEngines.js';

export type SearchExecutionContext = {
    searchMode?: AppConfig['searchMode'];
};

export type SearchEngineExecutor = (query: string, limit: number, context?: SearchExecutionContext) => Promise<SearchResult[]>;
export type SearchEngineExecutorMap = Partial<Record<string, SearchEngineExecutor>>;

export type SearchExecutionFailure = {
    engine: string;
    code: 'engine_error' | 'unsupported_engine';
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
        return parsed.toString();
    } catch {
        return url.trim();
    }
}

/**
 * 跨引擎融合：按规范化 URL 去重，并按"被多少个引擎命中"加权排序。
 * - 命中引擎数越多，排名越靠前（多数引擎认为相关 => 更可信）
 * - 同分时保留先到的引擎结果（保持原始顺序稳定）
 * - 每个结果记录它来自哪些引擎（searchResult.source / engine 字段保留首个）
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
            let deadlineHit = false;

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

                // 失败指数退避：最多重试 2 次（300ms/600ms 间隔）
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
                        if (attempt < 2) {
                            const backoff = 300 * (2 ** attempt);
                            console.error(`⚠️ Engine ${engine} failed (attempt ${attempt + 1}/3), retrying in ${backoff}ms:`, error instanceof Error ? error.message : String(error));
                            await sleep(backoff);
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

            // 每个引擎任务包一层 deadline：到点未完成按超时处理（记录 partialFailure，不阻塞整体）
            const engineResults = await Promise.all(tasks.map((task, index) =>
                Promise.race([
                    task,
                    new Promise<SearchResult[]>((resolve) => {
                        const remaining = deadlineAt - Date.now();
                        const wait = remaining > 0 ? remaining : 0;
                        setTimeout(() => {
                            deadlineHit = true;
                            if (!partialFailures.some((failure) => failure.engine === engines[index])) {
                                partialFailures.push({
                                    engine: engines[index],
                                    code: 'engine_error',
                                    message: buildHintedMessage(engines[index], `Search deadline exceeded (${deadlineMs}ms total budget)`)
                                });
                            }
                            resolve([]);
                        }, wait);
                    })
                ])
            ));
            let merged = mergeSearchResults(engineResults).slice(0, limit);

            // 配额 >0 但引擎返回 0 条时，记录为可见的部分失败，便于 agent 区分
            // "该引擎没结果" 与 "该引擎没被调用"（配额 0 的情况）。
            engines.forEach((engine, index) => {
                const executor = engineMap[engine];
                if (executor && limits[index] > 0 && engineResults[index].length === 0) {
                    if (!partialFailures.some((failure) => failure.engine === engine)) {
                        partialFailures.push({
                            engine,
                            code: 'engine_error',
                            message: buildHintedMessage(engine, 'Engine returned no results for the allocated quota')
                        });
                    }
                }
            });

            // 级联补位：minResults 已设且结果不足时，用未请求的可用引擎按序补跑，
            // 直到凑足 minResults 或候选耗尽/预算超时。默认不启用（minResults 为 0）。
            const cascadedEngines: string[] = [];
            if (minResults && minResults > merged.length) {
                const usedEngines = new Set(engines);
                const candidates = SUPPORTED_SEARCH_ENGINES.filter(
                    (engine) => !usedEngines.has(engine) && typeof engineMap[engine] === 'function'
                );
                for (const candidate of candidates) {
                    if (merged.length >= minResults) {
                        break;
                    }
                    const remaining = deadlineAt - Date.now();
                    if (remaining <= 0) {
                        break;
                    }
                    const gap = minResults - merged.length;
                    let resolvedByEngine = false;
                    try {
                        const cascaded = await Promise.race([
                            (async () => {
                                const results = await engineMap[candidate]!(cleanQuery, gap, { searchMode: effectiveSearchMode });
                                resolvedByEngine = true;
                                return results;
                            })(),
                            new Promise<SearchResult[]>((resolve) => {
                                setTimeout(() => {
                                    if (resolvedByEngine) {
                                        resolve([]);
                                        return;
                                    }
                                    partialFailures.push({
                                        engine: candidate,
                                        code: 'engine_error',
                                        message: buildHintedMessage(candidate, `Search deadline exceeded (${deadlineMs}ms total budget)`)
                                    });
                                    resolve([]);
                                }, remaining);
                            })
                        ]);
                        if (cascaded.length > 0) {
                            cascadedEngines.push(candidate);
                            engineResults.push(cascaded);
                            merged = mergeSearchResults(engineResults).slice(0, limit);
                        } else {
                            partialFailures.push({
                                engine: candidate,
                                code: 'engine_error',
                                message: buildHintedMessage(candidate, 'Engine returned no results for the cascaded quota')
                            });
                        }
                    } catch (error) {
                        partialFailures.push({
                            engine: candidate,
                            code: 'engine_error',
                            message: buildHintedMessage(candidate, error instanceof Error ? error.message : String(error))
                        });
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
