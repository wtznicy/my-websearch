import { describe, expect, it } from 'vitest';
import { clearDocsCache, docsCacheKey, getDocsCache, setDocsCache } from '../../core/docs/docsCache.js';

describe('queryDocs cache', () => {
    it('builds version-aware cache keys', () => {
        expect(docsCacheKey({ library: 'Next.js', version: '14.2.0', query: 'Middleware', limit: 5, strict: false }))
            .toBe('next.js|14.2.0|middleware|5|loose');
        expect(docsCacheKey({ library: 'react', limit: 3 })).toBe('react|||3|loose');
    });

    it('stores and retrieves values, and clear removes them', () => {
        clearDocsCache();
        const key = 'test-lib|1.0.0|overview|5|loose';
        setDocsCache(key, { text: '# Docs', source: 'context7', confidence: 'high', cachedAt: Date.now() });
        expect(getDocsCache(key)?.text).toBe('# Docs');
        clearDocsCache();
        expect(getDocsCache(key)).toBeNull();
    });
});
