import { describe, it, expect } from 'vitest';
import { parseBraveResults } from '../../engines/brave/brave.js';

// Brave 用 SvelteKit SSR：.snippet > .result-content > a(.search-snippet-title + .site-name-wrapper) + .generic-snippet
const NORMAL_PAGE = `<!DOCTYPE html>
<html>
<head><title>websearch mcp - Brave Search</title></head>
<body>
<div id="results">
  <div class="snippet svelte-abc123">
    <div class="result-content">
      <a href="https://example.com/one">
        <span class="site-name-wrapper">example.com</span>
        <span class="search-snippet-title">第一个结果</span>
      </a>
      <div class="generic-snippet">这是第一条描述</div>
    </div>
  </div>
  <div class="snippet">
    <div class="result-content">
      <a href="https://example.com/two">
        <span class="site-name-wrapper">example.com</span>
        <span class="search-snippet-title">第二个结果</span>
      </a>
      <div class="generic-snippet">第二条描述</div>
    </div>
  </div>
</div>
</body>
</html>`;

describe('parseBraveResults', () => {
    it('should parse titles, urls, descriptions and sources', () => {
        const results = parseBraveResults(NORMAL_PAGE, new Set<string>());

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            title: '第一个结果',
            url: 'https://example.com/one',
            description: '这是第一条描述',
            source: 'example.com',
            engine: 'brave'
        });
    });

    it('should dedupe urls via the provided seenUrls set', () => {
        const seenUrls = new Set<string>(['https://example.com/one']);
        const results = parseBraveResults(NORMAL_PAGE, seenUrls);

        expect(results).toHaveLength(1);
        expect(results[0].url).toBe('https://example.com/two');
    });

    it('should skip cards without .result-content', () => {
        const html = '<div class="snippet"><div class="result-content"></div><div class="snippet"><p>no content</p></div></div>';
        expect(parseBraveResults(html, new Set<string>())).toEqual([]);
    });

    it('should normalize breadcrumb source text to the URL hostname', () => {
        const html = `<div class="snippet">
            <div class="result-content">
                <a href="https://cloud.google.com/discover/ai">
                    <span class="site-name-wrapper">cloud.google.com › discover › ai-guides</span>
                    <span class="search-snippet-title">Google Cloud AI</span>
                </a>
                <div class="generic-snippet">描述</div>
            </div>
        </div>`;
        const results = parseBraveResults(html, new Set<string>());
        expect(results[0].source).toBe('cloud.google.com');
    });

    it('should return empty array for page without results', () => {
        expect(parseBraveResults('<html><body>no results</body></html>', new Set<string>())).toEqual([]);
    });
});
