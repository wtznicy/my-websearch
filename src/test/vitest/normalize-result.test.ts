import { describe, expect, it } from 'vitest';
import { normalizeSearchResult } from '../../core/search/normalizeResult.js';
import type { SearchResult } from '../../types.js';

const base: SearchResult = {
    title: '  Hello   World  ',
    url: 'https://example.com/a',
    description: 'x'.repeat(600),
    source: 'example.com',
    engine: 'bing'
};

describe('normalizeSearchResult', () => {
    it('collapses whitespace and truncates descriptions', () => {
        const result = normalizeSearchResult(base);
        expect(result?.title).toBe('Hello World');
        expect(result?.description.length).toBe(400);
    });

    it('drops non-http(s) and malformed URLs', () => {
        expect(normalizeSearchResult({ ...base, url: 'javascript:alert(1)' })).toBeNull();
        expect(normalizeSearchResult({ ...base, url: 'not a url' })).toBeNull();
    });

    it('drops results without a title', () => {
        expect(normalizeSearchResult({ ...base, title: '   ' })).toBeNull();
    });

    it('fills an empty source from the URL hostname', () => {
        const result = normalizeSearchResult({ ...base, source: '' });
        expect(result?.source).toBe('example.com');
    });
});
