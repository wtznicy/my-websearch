import {
    searchContext7Libraries,
    fetchContext7Docs,
    Context7Library,
    Context7DocsResult,
    isContext7QuotaExhaustedError,
    markContext7QuotaExhausted
} from '../../engines/context7/context7.js';
import { AppError } from '../errors.js';

export type Context7LibrariesService = {
    execute(input: { libraryName: string; query?: string; limit?: number }): Promise<{
        query: string;
        libraryName: string;
        results: Context7Library[];
    }>;
};

export type Context7DocsInput = {
    library?: string;
    libraryId?: string;
    libraryName?: string;
    query?: string;
    limit?: number;
    strict?: boolean;
    signal?: AbortSignal;
};

export type Context7DocsService = {
    execute(input: Context7DocsInput): Promise<Context7DocsResult>;
};

// 文档类响应时效性低，做短 TTL 内存缓存（10 分钟）。
// 无 CONTEXT7_API_KEY 时公开 API 速率限制很低，重复的 resolveLibraryId/queryDocs
// 每次都直打上游容易被限流，缓存可显著降低命中率。
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();

// 库名解析映射表缓存（30 分钟），按 libraryName 归一化为 key，避免多次 query 问答重复打 libs/search 消耗配额
const RESOLVED_NAME_CACHE_TTL_MS = 30 * 60 * 1000;
type ResolvedLibraryEntry = {
    bestId: string;
    alternatives: Array<{ id: string; title: string; description?: string }>;
    confidence: 'high' | 'medium' | 'low';
    expiresAt: number;
};
const resolvedNameCache = new Map<string, ResolvedLibraryEntry>();

function cachedGet<T>(key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) {
        return undefined;
    }
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return undefined;
    }
    return entry.value as T;
}

function cachedSet(key: string, value: unknown, ttlMs = CACHE_TTL_MS): void {
    const now = Date.now();
    // 淘汰过期条目
    for (const [k, entry] of cache) {
        if (now > entry.expiresAt) {
            cache.delete(k);
        }
    }
    // 超过容量时删除最老的（Map 保持插入序）
    while (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        cache.delete(oldest);
    }
    cache.set(key, { value, expiresAt: now + ttlMs });
}

export function resetContext7Cache(): void {
    cache.clear();
    resolvedNameCache.clear();
}

/**
 * 候选库智能打分函数（防个人 fork / 镜像库排在官方库前面）：
 * 1. 名称或 ID 尾段精确匹配优先
 * 2. 综合质量分（trustScore + benchmarkScore）与代码片段数排序
 */
export function pickBestLibrary(candidates: Context7Library[], rawInput: string): Context7Library | undefined {
    if (!candidates || candidates.length === 0) {
        return undefined;
    }
    const target = rawInput.trim().toLowerCase();
    return [...candidates].sort((a, b) => {
        const aExact = a.title.toLowerCase() === target || a.id.toLowerCase().endsWith(`/${target}`) ? 1 : 0;
        const bExact = b.title.toLowerCase() === target || b.id.toLowerCase().endsWith(`/${target}`) ? 1 : 0;
        if (aExact !== bExact) {
            return bExact - aExact;
        }
        const aSnippets = a.totalSnippets ?? 0;
        const bSnippets = b.totalSnippets ?? 0;
        const aScore = (a.trustScore ?? 0) * 10 + (a.benchmarkScore ?? 0) + Math.min(aSnippets, 500) / 100;
        const bScore = (b.trustScore ?? 0) * 10 + (b.benchmarkScore ?? 0) + Math.min(bSnippets, 500) / 100;
        return bScore - aScore;
    })[0];
}

/**
 * 候选库匹配置信度评估：
 * - high: 库名/别名/完整ID精确匹配
 * - medium: 包含关系或词干高度接近
 * - low: 模糊弱相关（避免未知库/拼写错误自信地返回无关文档）
 */
export function evaluateLibraryMatchConfidence(
    candidate: Context7Library,
    rawInput: string
): 'high' | 'medium' | 'low' {
    const target = rawInput.trim().toLowerCase().replace(/^@/, '');
    const candidateTitle = candidate.title.trim().toLowerCase();
    const candidateId = candidate.id.trim().toLowerCase().replace(/^\//, '');
    const candidateSlug = candidateId.split('/').pop()?.split('@')[0] ?? '';

    // 精确匹配：标题、完整ID或尾部slug完全一致
    if (
        candidateTitle === target ||
        candidateSlug === target ||
        candidateId === target ||
        candidateId.endsWith(`/${target}`)
    ) {
        return 'high';
    }

    // 去除特殊字符后的精确匹配（如 next.js 与 nextjs）
    const cleanTarget = target.replace(/[-_.]/g, '');
    const cleanSlug = candidateSlug.replace(/[-_.]/g, '');
    const cleanTitle = candidateTitle.replace(/[-_.]/g, '');

    if (
        cleanTarget.length > 0 &&
        (cleanSlug === cleanTarget || cleanTitle === cleanTarget)
    ) {
        return 'high';
    }

    // 中等置信度：包含关系（目标包含slug或slug包含目标，且长度差距不大）
    if (
        (cleanSlug.includes(cleanTarget) && cleanTarget.length >= 3) ||
        (cleanTarget.includes(cleanSlug) && cleanSlug.length >= 3 && cleanSlug.length / cleanTarget.length > 0.4) ||
        (cleanTitle.includes(cleanTarget) && cleanTarget.length >= 3) ||
        (cleanTarget.includes(cleanTitle) && cleanTitle.length >= 3 && cleanTitle.length / cleanTarget.length > 0.4)
    ) {
        return 'medium';
    }

    // 弱相关或无关匹配
    return 'low';
}

export function createContext7Services() {
    return {
        libraries: {
            async execute(input: { libraryName: string; query?: string; limit?: number }) {
                const libraryName = input.libraryName.trim();
                if (!libraryName) {
                    throw new AppError({
                        code: 'invalid_arguments',
                        retryable: false,
                        engine: 'context7',
                        message: 'Library name cannot be empty'
                    });
                }
                const cacheKey = `libraries:${libraryName}:${(input.query ?? '').trim()}:${input.limit ?? 5}`;
                const cached = cachedGet<{ query: string; libraryName: string; results: Context7Library[] }>(cacheKey);
                if (cached) {
                    return cached;
                }
                try {
                    const result = await searchContext7Libraries(libraryName, input.query, input.limit ?? 5);
                    cachedSet(cacheKey, result);
                    return result;
                } catch (error) {
                    if (isContext7QuotaExhaustedError(error)) {
                        markContext7QuotaExhausted();
                    }
                    throw error;
                }
            }
        } satisfies Context7LibrariesService,

        docs: {
            async execute(input: Context7DocsInput) {
                const rawTarget = (input.library ?? input.libraryId ?? input.libraryName ?? '').trim();
                if (!rawTarget) {
                    throw new AppError({
                        code: 'invalid_arguments',
                        retryable: false,
                        engine: 'context7',
                        message: 'Library name or ID cannot be empty'
                    });
                }

                const queryStr = (input.query ?? '').trim();
                const limitVal = input.limit ?? 5;

                // 核心解析与文档获取流程
                async function resolveAndFetchDocs(
                    libraryName: string,
                    originalRequested?: string
                ): Promise<Context7DocsResult> {
                    if (input.signal?.aborted) {
                        throw new AppError({
                            code: 'network_timeout',
                            retryable: true,
                            engine: 'context7',
                            message: 'Request aborted by client'
                        });
                    }
                    const normalizedKey = libraryName.toLowerCase();
                    const now = Date.now();
                    let bestId: string;
                    let alternatives: Array<{ id: string; title: string; description?: string }> = [];
                    let confidence: 'high' | 'medium' | 'low' = 'high';

                    const cachedResolved = resolvedNameCache.get(normalizedKey);
                    if (cachedResolved && now < cachedResolved.expiresAt) {
                        bestId = cachedResolved.bestId;
                        alternatives = cachedResolved.alternatives;
                        confidence = cachedResolved.confidence;
                    } else {
                        const searchRes = await searchContext7Libraries(libraryName, input.query, 5);
                        const best = pickBestLibrary(searchRes.results, libraryName);
                        if (!best) {
                            throw new AppError({
                                code: 'not_found',
                                retryable: false,
                                engine: 'context7',
                                message: `No matching Context7 library found for "${libraryName}". Try searching with another name or provide exact /owner/repo ID.`
                            });
                        }
                        bestId = best.id;
                        confidence = evaluateLibraryMatchConfidence(best, libraryName);
                        alternatives = searchRes.results
                            .filter((r) => r.id !== best.id)
                            .slice(0, 3)
                            .map((r) => ({ id: r.id, title: r.title, description: r.description }));

                        resolvedNameCache.set(normalizedKey, {
                            bestId,
                            alternatives,
                            confidence,
                            expiresAt: now + RESOLVED_NAME_CACHE_TTL_MS
                        });
                    }

                    if (input.strict && confidence === 'low') {
                        const altsDesc = alternatives.length > 0
                            ? ` Candidates: ${[bestId, ...alternatives.map((a) => a.id)].join(', ')}.`
                            : ` Closest was "${bestId}".`;
                        throw new AppError({
                            code: 'not_found',
                            retryable: false,
                            engine: 'context7',
                            message: `Low confidence match for library "${libraryName}".${altsDesc} Set strict=false to force fetching.`
                        });
                    }

                    if (input.signal?.aborted) {
                        throw new AppError({
                            code: 'network_timeout',
                            retryable: true,
                            engine: 'context7',
                            message: 'Request aborted by client'
                        });
                    }

                    const docsResult = await fetchContext7Docs(bestId, input.query, limitVal);
                    const enriched: Context7DocsResult = {
                        ...docsResult,
                        resolvedFrom: originalRequested ?? libraryName,
                        alternativeLibraries: alternatives.length > 0 ? alternatives : undefined,
                        matchConfidence: confidence
                    };
                    return enriched;
                }

                // 分支 1：传入的是明确路径 ID（以 '/' 开头，如 '/vercel/next.js' 或 '/vercel/next.js@v15.1.8'）
                if (rawTarget.startsWith('/')) {
                    const cacheKey = `docs:${rawTarget}:${queryStr}:${limitVal}`;
                    const cached = cachedGet<Context7DocsResult>(cacheKey);
                    if (cached) {
                        return cached;
                    }

                    try {
                        const result = await fetchContext7Docs(rawTarget, input.query, limitVal);
                        cachedSet(cacheKey, result);
                        if (result.redirectedFrom) {
                            cachedSet(`docs:${result.redirectedFrom}:${queryStr}:${limitVal}`, result);
                        }
                        if (result.redirectUrl && result.redirectUrl !== rawTarget) {
                            cachedSet(`docs:${result.redirectUrl}:${queryStr}:${limitVal}`, result);
                        }
                        return result;
                    } catch (error) {
                        // 404 / 瞎猜 ID 自愈兜底：例如传了 /tailwind/tailwindcss 找不到，提取尾段 tailwindcss 回退到名称解析
                        const segments = rawTarget.replace(/^\/+/, '').split('/');
                        const trailing = segments.pop()?.split('@')[0]?.trim();
                        if (trailing && trailing !== rawTarget) {
                            try {
                                const healed = await resolveAndFetchDocs(trailing, rawTarget);
                                cachedSet(cacheKey, healed);
                                return healed;
                            } catch {
                                // 自愈失败则抛出原错误
                            }
                        }

                        if (isContext7QuotaExhaustedError(error)) {
                            markContext7QuotaExhausted();
                        }
                        throw error;
                    }
                }

                // 分支 2：传入的是自然库名（不带 '/'，如 'next.js'、'react'、'fastapi'）
                const cacheKey = `docs:resolved:${rawTarget.toLowerCase()}:${queryStr}:${limitVal}`;
                const cached = cachedGet<Context7DocsResult>(cacheKey);
                if (cached) {
                    return cached;
                }

                try {
                    const result = await resolveAndFetchDocs(rawTarget);
                    cachedSet(cacheKey, result);
                    return result;
                } catch (error) {
                    if (isContext7QuotaExhaustedError(error)) {
                        markContext7QuotaExhausted();
                    }
                    throw error;
                }
            }
        } satisfies Context7DocsService
    };
}
