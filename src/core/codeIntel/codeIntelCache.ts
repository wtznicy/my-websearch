import { createHash } from 'node:crypto';
import { getNumber } from '../../config/env.js';
import type { CodeSymbolCallSite } from './treeSitter.js';
import type { CodeSymbolDefinition, CodeSymbolResult } from './remoteCodeIntel.js';

export interface CachedFileAnalysis {
    found: CodeSymbolDefinition[];
    callSites: CodeSymbolCallSite[];
    binding: CodeSymbolDefinition | null;
}

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

export class CodeIntelTtlCache<T> {
    private readonly entries = new Map<string, CacheEntry<T>>();

    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries = 300
    ) {}

    get(key: string): T | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return null;
        }
        // Refresh LRU ordering.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T): void {
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (!oldest) break;
            this.entries.delete(oldest);
        }
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }
}

const ttlFromEnv = (name: string, fallback: number): number => {
    return getNumber(name, fallback, { min: 1 });
};

export const symbolResultCache = new CodeIntelTtlCache<CodeSymbolResult>(
    ttlFromEnv('CODE_SYMBOL_CACHE_TTL_MS', 30 * 60 * 1000),
    200
);
export const fileContentCache = new CodeIntelTtlCache<string | null>(
    ttlFromEnv('CODE_SYMBOL_CONTENT_TTL_MS', 10 * 60 * 1000),
    500
);
export const fileAnalysisCache = new CodeIntelTtlCache<CachedFileAnalysis>(
    ttlFromEnv('CODE_SYMBOL_ANALYSIS_TTL_MS', 30 * 60 * 1000),
    500
);

export function hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}

export function clearCodeIntelCaches(): void {
    symbolResultCache.clear();
    fileContentCache.clear();
    fileAnalysisCache.clear();
}
