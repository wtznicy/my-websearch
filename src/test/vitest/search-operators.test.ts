import { describe, expect, it } from 'vitest';
import {
    buildEngineQuery,
    matchesSearchOperators,
    parseSearchOperators
} from '../../utils/searchOperators.js';
import type { SearchResult } from '../../types.js';

const result = (overrides: Partial<SearchResult> = {}): SearchResult => ({
    title: 'Rust async runtime',
    url: 'https://docs.rs/tokio/latest/tokio/',
    description: 'Tokio is an asynchronous runtime for Rust.',
    source: 'docs.rs',
    engine: 'bing',
    ...overrides
});

describe('search operators', () => {
    it('parses site, filetype, date and exclusion operators', () => {
        const parsed = parseSearchOperators('rust site:docs.rs filetype:pdf -old after:2025-01-01 before:2025-12-31');
        expect(parsed.text).toBe('rust');
        expect(parsed.siteDomains).toEqual(['docs.rs']);
        expect(parsed.fileTypes).toEqual(['pdf']);
        expect(parsed.after).toBe('2025-01-01');
        expect(parsed.before).toBe('2025-12-31');
        expect(parsed.excludedTerms).toEqual(['old']);
    });

    it('supports quoted values and leaves malformed operators in text', () => {
        const parsed = parseSearchOperators('rust -"old api" site:"https://docs.rs/tokio" after:yesterday');
        expect(parsed.siteDomains).toEqual(['docs.rs']);
        expect(parsed.excludedTerms).toEqual(['old api']);
        expect(parsed.after).toBeUndefined();
        expect(parsed.text).toContain('after:yesterday');
    });

    it('keeps hyphenated model names intact', () => {
        const parsed = parseSearchOperators('GLM-4.6V-Flash release notes');
        expect(parsed.text).toBe('GLM-4.6V-Flash release notes');
        expect(parsed.excludedTerms).toEqual([]);
    });

    it('rebuilds native queries and leaves API engines with plain keywords', () => {
        const parsed = parseSearchOperators('rust site:docs.rs filetype:pdf');
        expect(buildEngineQuery(parsed, true)).toBe('rust site:docs.rs filetype:pdf');
        expect(buildEngineQuery(parsed, false)).toBe('rust');
    });

    it('filters by host, extension, exclusion and publication date', () => {
        const parsed = parseSearchOperators('rust site:docs.rs filetype:html -python after:2025-01-01 before:2025-12-31');
        expect(matchesSearchOperators(result({ url: 'https://docs.rs/tokio/latest/tokio.html', publishedAt: '2025-06-01' }), parsed)).toBe(true);
        expect(matchesSearchOperators(result({ url: 'https://crates.io/crates/tokio' }), parsed)).toBe(false);
        expect(matchesSearchOperators(result({ url: 'https://docs.rs/tokio/latest/tokio.pdf' }), parsed)).toBe(false);
        expect(matchesSearchOperators(result({ description: 'Python binding' }), parsed)).toBe(false);
        expect(matchesSearchOperators(result({ publishedAt: '2024-12-31' }), parsed)).toBe(false);
        expect(matchesSearchOperators(result({ publishedAt: '2026-01-01' }), parsed)).toBe(false);
    });

    it('keeps results with unknown dates', () => {
        const parsed = parseSearchOperators('rust after:2025-01-01');
        expect(matchesSearchOperators(result({ publishedAt: undefined }), parsed)).toBe(true);
    });
});
