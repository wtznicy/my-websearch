import {
    searchContext7Libraries,
    fetchContext7Docs,
    Context7Library,
    Context7DocsResult
} from '../../engines/context7/context7.js';

export type Context7LibrariesService = {
    execute(input: { libraryName: string; query?: string; limit?: number }): Promise<{
        query: string;
        libraryName: string;
        results: Context7Library[];
    }>;
};

export type Context7DocsService = {
    execute(input: { libraryId: string; query?: string; limit?: number }): Promise<Context7DocsResult>;
};

// 文档类响应时效性低，做短 TTL 内存缓存（10 分钟）。
// 无 CONTEXT7_API_KEY 时公开 API 速率限制很低，重复的 resolveLibraryId/queryDocs
// 每次都直打上游容易被限流，缓存可显著降低命中率。
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();

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

function cachedSet(key: string, value: unknown): void {
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
    cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
}

export function createContext7Services() {
    return {
        libraries: {
            async execute(input: { libraryName: string; query?: string; limit?: number }) {
                const libraryName = input.libraryName.trim();
                if (!libraryName) {
                    throw new Error('Library name cannot be empty');
                }
                const cacheKey = `libraries:${libraryName}:${(input.query ?? '').trim()}:${input.limit ?? 5}`;
                const cached = cachedGet<{ query: string; libraryName: string; results: Context7Library[] }>(cacheKey);
                if (cached) {
                    return cached;
                }
                const result = await searchContext7Libraries(libraryName, input.query, input.limit ?? 5);
                cachedSet(cacheKey, result);
                return result;
            }
        } satisfies Context7LibrariesService,
        docs: {
            async execute(input: { libraryId: string; query?: string; limit?: number }) {
                const cacheKey = `docs:${input.libraryId.trim()}:${(input.query ?? '').trim()}:${input.limit ?? 5}`;
                const cached = cachedGet<Context7DocsResult>(cacheKey);
                if (cached) {
                    return cached;
                }
                const result = await fetchContext7Docs(input.libraryId, input.query, input.limit ?? 5);
                cachedSet(cacheKey, result);
                return result;
            }
        } satisfies Context7DocsService
    };
}
