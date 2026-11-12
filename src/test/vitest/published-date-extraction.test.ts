import { describe, expect, it } from 'vitest';
import {
    extractPublishedDateFromHtml,
    extractDateFromJsonLd,
    isValidPublishedYear
} from '../../engines/web/publishedDate.js';

describe('extractPublishedDateFromHtml', () => {
    it('extracts JSON-LD datePublished', () => {
        const html = '<script type="application/ld+json">{"@type":"Article","datePublished":"2024-10-21T08:00:00+08:00"}</script>';
        expect(extractPublishedDateFromHtml(html)).toBe('2024-10-21');
    });

    it('prioritizes Article entity over WebSite in @graph complex JSON-LD', () => {
        const html = `
        <script type="application/ld+json">
        {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "WebSite",
                    "@id": "https://example.com/#website",
                    "datePublished": "2015-01-01T00:00:00Z"
                },
                {
                    "@type": "BlogPosting",
                    "headline": "FastAPI Best Practices",
                    "datePublished": "2024-05-10T12:00:00Z",
                    "dateModified": "2024-05-11T12:00:00Z"
                }
            ]
        }
        </script>`;
        expect(extractPublishedDateFromHtml(html)).toBe('2024-05-10');
    });

    it('extracts date from JSON-LD array structure', () => {
        const html = `
        <script type="application/ld+json">
        [
            {
                "@type": "NewsArticle",
                "headline": "Breaking News",
                "datePublished": "2026-03-01T15:30:00+08:00"
            }
        ]
        </script>`;
        expect(extractPublishedDateFromHtml(html)).toBe('2026-03-01');
    });

    it('rejects 1970 UNIX epoch default timestamp in JSON-LD', () => {
        const html = '<script type="application/ld+json">{"@type":"Article","datePublished":"1970-01-01T00:00:00Z"}</script>';
        expect(extractPublishedDateFromHtml(html)).toBeUndefined();
    });

    it('rejects unrealistic future year beyond currentYear + 1', () => {
        const futureDate = `${new Date().getUTCFullYear() + 5}-01-01`;
        expect(isValidPublishedYear(futureDate)).toBe(false);
        const html = `<script type="application/ld+json">{"@type":"Article","datePublished":"${futureDate}"}</script>`;
        expect(extractPublishedDateFromHtml(html)).toBeUndefined();
    });

    it('gracefully falls back to meta tags when JSON-LD is malformed', () => {
        const html = `
        <script type="application/ld+json">{ invalid json here </script>
        <meta property="article:published_time" content="2025-06-18T10:00:00Z">
        `;
        expect(extractPublishedDateFromHtml(html)).toBe('2025-06-18');
    });

    it('extracts OpenGraph article:published_time in either attribute order', () => {
        expect(extractPublishedDateFromHtml(
            '<meta property="article:published_time" content="2025-03-02T10:00:00Z">'
        )).toBe('2025-03-02');
        expect(extractPublishedDateFromHtml(
            '<meta content="2025-03-02T10:00:00Z" property="article:published_time">'
        )).toBe('2025-03-02');
        expect(extractPublishedDateFromHtml(
            '<meta property="og:article:published_time" content="2025-03-02T10:00:00Z">'
        )).toBe('2025-03-02');
    });

    it('extracts <time datetime>', () => {
        expect(extractPublishedDateFromHtml('<time datetime="2023-07-09">July 9</time>')).toBe('2023-07-09');
    });

    it('falls back to URL path date when HTML lacks structured metadata', () => {
        const html = '<html><body><h1>BlogPost Without Meta</h1></body></html>';
        expect(extractPublishedDateFromHtml(html, { url: 'https://example.com/2024/09/15/my-first-post' })).toBe('2024-09-15');
    });

    it('returns undefined when there is no usable date', () => {
        expect(extractPublishedDateFromHtml('<html><body>No date here</body></html>')).toBeUndefined();
        expect(extractPublishedDateFromHtml('<meta property="article:published_time" content="not-a-date">')).toBeUndefined();
        expect(extractPublishedDateFromHtml('')).toBeUndefined();
    });
});
