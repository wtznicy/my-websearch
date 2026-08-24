import { describe, it, expect } from 'vitest';
import {
    parseDuckDuckGoJsonpPayload,
    parseDuckDuckGoHtmlResults
} from '../../engines/duckduckgo/searchDuckDuckGo.js';

const JSONP_PAYLOAD = `DDG.pageLayout.load('d', [{"t":"<b>MCP</b> title","u":"https://example.com/one","a":"desc with <b>bold</b>","i":"example.com"},{"t":"Second","u":"https://example.com/two","a":"<b>second</b> desc","sn":"source-org"},{"n":true,"t":"navigation item"}]);`;

const HTML_PAGE = `<!DOCTYPE html>
<html><body>
<div class="result">
  <a class="result__a" href="https://example.com/one">第一个结果</a>
  <div class="result__snippet">这是第一条描述</div>
  <div class="result__url">example.com</div>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/two">第二个结果</a>
  <div class="result__snippet">第二条描述</div>
  <div class="result__url">example.org</div>
</div>
<div class="result result--ad">
  <a class="result__a" href="https://ads.example.com/sponsored">广告</a>
  <div class="result__snippet">广告描述</div>
  <div class="result__url">ads.example.com</div>
</div>
</body></html>`;

describe('parseDuckDuckGoJsonpPayload', () => {
    it('should parse JSONP results and strip highlight tags', () => {
        const results = parseDuckDuckGoJsonpPayload(JSONP_PAYLOAD);

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            title: 'MCP title',
            url: 'https://example.com/one',
            description: 'desc with bold',
            source: 'example.com',
            engine: 'duckduckgo'
        });
        expect(results[1].source).toBe('source-org');
    });

    it('should skip navigation items (item.n)', () => {
        const results = parseDuckDuckGoJsonpPayload(JSONP_PAYLOAD);
        expect(results.some((r) => r.title === 'navigation item')).toBe(false);
    });

    it('should return empty array for invalid payload', () => {
        expect(parseDuckDuckGoJsonpPayload('not jsonp at all')).toEqual([]);
        expect(parseDuckDuckGoJsonpPayload('')).toEqual([]);
    });
});

describe('parseDuckDuckGoHtmlResults', () => {
    it('should parse results, filter ads, and count raw cards', () => {
        const parsed = parseDuckDuckGoHtmlResults(HTML_PAGE, 10, new Set<string>());

        expect(parsed.results).toHaveLength(2);
        expect(parsed.rawCount).toBe(3); // 2 results + 1 ad
        expect(parsed.results[0]).toMatchObject({
            title: '第一个结果',
            url: 'https://example.com/one',
            description: '这是第一条描述',
            source: 'example.com'
        });
        expect(parsed.results.some((r) => r.url.includes('ads.example.com'))).toBe(false);
    });

    it('should respect maxResults and dedupe via seenUrls', () => {
        const seenUrls = new Set<string>(['https://example.com/one']);
        const parsed = parseDuckDuckGoHtmlResults(HTML_PAGE, 1, seenUrls);

        expect(parsed.results).toHaveLength(1);
        expect(parsed.results[0].url).toBe('https://example.com/two');
        expect(parsed.rawCount).toBe(3);
    });

    it('should return empty results for page without cards', () => {
        const parsed = parseDuckDuckGoHtmlResults('<html><body>no results</body></html>', 10, new Set<string>());
        expect(parsed.results).toEqual([]);
        expect(parsed.rawCount).toBe(0);
    });
});
