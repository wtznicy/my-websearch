import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeIntelTtlCache, clearCodeIntelCaches } from '../../core/codeIntel/codeIntelCache.js';

describe('code intelligence cache', () => {
    afterEach(() => {
        vi.useRealTimers();
        clearCodeIntelCaches();
    });

    it('expires entries after the TTL', () => {
        vi.useFakeTimers();
        const cache = new CodeIntelTtlCache<string>(1000);
        cache.set('key', 'value');
        expect(cache.get('key')).toBe('value');
        vi.advanceTimersByTime(1001);
        expect(cache.get('key')).toBeNull();
    });

    it('evicts the least-recently-used entry when over capacity', () => {
        const cache = new CodeIntelTtlCache<number>(60_000, 2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.get('a');
        cache.set('c', 3);
        expect(cache.get('b')).toBeNull();
        expect(cache.get('a')).toBe(1);
        expect(cache.get('c')).toBe(3);
    });
});
