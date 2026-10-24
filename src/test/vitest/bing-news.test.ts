import { describe, expect, it } from 'vitest';
import { decodeBingNewsUrl, parseBingNewsRss } from '../../engines/bingNews/bingNews.js';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

function rssItem(title: string, url: string, pubDate: string): string {
    return `<item><title>${title}</title><link>${url}</link><description>Desc &amp; more</description><pubDate>${pubDate}</pubDate></item>`;
}

describe('Bing News RSS', () => {
    it('decodes apiclick url parameter', () => {
        const link = 'http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fexample.com%2Fnews%2Fai&c=1';
        expect(decodeBingNewsUrl(link)).toBe('https://example.com/news/ai');
        expect(decodeBingNewsUrl('https://example.com/direct')).toBe('https://example.com/direct');
    });

    it('keeps only items within the 24h window and decodes entities', () => {
        const fresh = new Date(NOW - 60 * 60 * 1000).toUTCString();
        const old = new Date(NOW - 30 * 60 * 60 * 1000).toUTCString();
        const xml = `<rss><channel>
            ${rssItem('Fresh &amp; AI', 'http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fexample.com%2Ffresh', fresh)}
            ${rssItem('Old news', 'https://example.com/old', old)}
            <item><title>No date</title><link>https://example.com/nodate</link></item>
        </channel></rss>`;

        const results = parseBingNewsRss(xml, { now: NOW, limit: 10 });
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            title: 'Fresh & AI',
            url: 'https://example.com/fresh',
            engine: 'bing-news'
        });
    });

    it('caps results at the requested limit', () => {
        const fresh = new Date(NOW - 60 * 60 * 1000).toUTCString();
        const items = Array.from({ length: 5 }, (_, i) => rssItem(`t${i}`, `https://example.com/${i}`, fresh)).join('');
        expect(parseBingNewsRss(`<rss><channel>${items}</channel></rss>`, { now: NOW, limit: 3 })).toHaveLength(3);
    });
});
