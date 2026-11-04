import { describe, it, expect } from 'vitest';
import { normalizeCodeSnippetPageTitle } from '../../engines/context7/context7.js';

describe('Context7 snippet pageTitle normalization', () => {
    it('keeps a real pageTitle as-is', () => {
        const normalized = normalizeCodeSnippetPageTitle({
            codeTitle: 'A',
            codeList: [],
            pageTitle: 'Real Title',
            codeId: 'https://github.com/x/y.md'
        });
        expect(normalized.pageTitle).toBe('Real Title');
    });

    it('falls back to the codeId filename when pageTitle is Unknown', () => {
        const normalized = normalizeCodeSnippetPageTitle({
            codeTitle: 'B',
            codeList: [],
            pageTitle: 'Unknown',
            codeId: 'https://github.com/expressjs/express/blob/master/_autodocs/07-middleware-and-routing.md'
        });
        expect(normalized.pageTitle).toBe('07 middleware and routing');
    });

    it('falls back to the codeId filename when pageTitle is missing', () => {
        const normalized = normalizeCodeSnippetPageTitle({
            codeTitle: 'C',
            codeList: [],
            codeId: 'https://example.com/docs/guide.md'
        });
        expect(normalized.pageTitle).toBe('guide');
    });

    it('omits pageTitle when no fallback is available', () => {
        expect(normalizeCodeSnippetPageTitle({ codeTitle: 'D', codeList: [], codeId: '' }).pageTitle).toBeUndefined();
        expect(normalizeCodeSnippetPageTitle({ codeTitle: 'E', codeList: [] }).pageTitle).toBeUndefined();
    });
});
