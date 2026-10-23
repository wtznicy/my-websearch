import { describe, expect, it } from 'vitest';
import { derivePublishedAt, extractDateFromText, extractDateFromUrl } from '../../core/search/dateExtraction.js';

describe('extractDateFromUrl', () => {
    it('extracts separated dates from news-style paths', () => {
        expect(extractDateFromUrl('https://example.com/2024/10/21/some-post')).toBe('2024-10-21');
        expect(extractDateFromUrl('https://example.com/blog/2024-01-05/post')).toBe('2024-01-05');
    });

    it('extracts compact 8-digit dates', () => {
        expect(extractDateFromUrl('https://example.com/20241021/post')).toBe('2024-10-21');
    });

    it('rejects version numbers, month-only paths and over-long segments', () => {
        expect(extractDateFromUrl('https://example.com/v2.10.21')).toBeUndefined();
        expect(extractDateFromUrl('https://example.com/item/2000/10/')).toBeUndefined();
        expect(extractDateFromUrl('https://example.com/2024/10/211')).toBeUndefined();
        expect(extractDateFromUrl('https://example.com/1999/10/21/post')).toBeUndefined();
    });

    it('rejects impossible calendar dates', () => {
        expect(extractDateFromUrl('https://example.com/2024/13/40/post')).toBeUndefined();
        expect(extractDateFromUrl('https://example.com/2024/02/31/post')).toBeUndefined();
    });
});

describe('extractDateFromText', () => {
    it('extracts absolute dates in common formats', () => {
        expect(extractDateFromText('发布于 2024年10月21日')).toBe('2024-10-21');
        expect(extractDateFromText('Updated 2024-10-21 by team')).toBe('2024-10-21');
    });

    it('delegates relative dates to the existing normalizer', () => {
        const now = new Date('2026-10-23T00:00:00Z');
        expect(extractDateFromText('3天前', now)).toBe('2026-10-20');
    });

    it('returns undefined when nothing looks like a date', () => {
        expect(extractDateFromText('typescript satisfies operator')).toBeUndefined();
        expect(extractDateFromText(undefined)).toBeUndefined();
    });
});

describe('derivePublishedAt priority', () => {
    it('prefers the engine date field, then title, then url', () => {
        expect(derivePublishedAt({
            rawDate: '2024-05-01',
            title: '2024-06-02 update',
            url: 'https://example.com/2024/07/03/post'
        })).toBe('2024-05-01');

        expect(derivePublishedAt({
            title: '2024-06-02 update',
            url: 'https://example.com/2024/07/03/post'
        })).toBe('2024-06-02');

        expect(derivePublishedAt({ url: 'https://example.com/2024/07/03/post' })).toBe('2024-07-03');
    });
});
