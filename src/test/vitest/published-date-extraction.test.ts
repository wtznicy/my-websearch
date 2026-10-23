import { describe, expect, it } from 'vitest';
import { extractPublishedDateFromHtml } from '../../engines/web/publishedDate.js';

describe('extractPublishedDateFromHtml', () => {
    it('extracts JSON-LD datePublished', () => {
        const html = '<script type="application/ld+json">{"@type":"Article","datePublished":"2024-10-21T08:00:00+08:00"}</script>';
        expect(extractPublishedDateFromHtml(html)).toBe('2024-10-21');
    });

    it('extracts OpenGraph article:published_time in either attribute order', () => {
        expect(extractPublishedDateFromHtml(
            '<meta property="article:published_time" content="2025-03-02T10:00:00Z">'
        )).toBe('2025-03-02');
        expect(extractPublishedDateFromHtml(
            '<meta content="2025-03-02T10:00:00Z" property="article:published_time">'
        )).toBe('2025-03-02');
    });

    it('extracts <time datetime>', () => {
        expect(extractPublishedDateFromHtml('<time datetime="2023-07-09">July 9</time>')).toBe('2023-07-09');
    });

    it('returns undefined when there is no usable date', () => {
        expect(extractPublishedDateFromHtml('<html><body>No date here</body></html>')).toBeUndefined();
        expect(extractPublishedDateFromHtml('<meta property="article:published_time" content="not-a-date">')).toBeUndefined();
        expect(extractPublishedDateFromHtml('')).toBeUndefined();
    });
});
