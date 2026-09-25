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

describe('parseBraveResults 广告过滤', () => {
    // 实测（2026-09-25，搜 'vue3'）Brave 顶部注入的商业推广卡：href 是相对跳转 /a/redirect?click_url=...
    const AD_CARD = `
      <div class="snippet svelte-jmfu5f" data-type="ad" data-keynav="true" id="search-ad"
           data-placement-id="4a76b5de" data-landing-page="https://www.booking.com/hotel/us/lodge.en-us.html">
        <div class="result-content">
          <a href="/a/redirect?click_url=https%3A%2F%2Fwww.booking.com%2Fhotel%2Fus%2Flodge.en-us.html&amp;ad_type_display=simple">
            <span class="site-name-wrapper">booking.com › hotel › us</span>
            <span class="search-snippet-title">Hotel Vue, Mountain View – Updated 2026 Prices</span>
          </a>
          <div class="generic-snippet">Located 7 miles from Stanford University</div>
        </div>
      </div>`;

    const ORGANIC_CARD = `
      <div class="snippet svelte-jmfu5f" data-pos="1" data-type="web" data-keynav="true">
        <div class="result-content">
          <a href="https://vuejs.org/">
            <span class="site-name-wrapper">vuejs.org</span>
            <span class="search-snippet-title">Vue.js</span>
          </a>
          <div class="generic-snippet">The Progressive JavaScript Framework</div>
        </div>
      </div>`;

    it('should skip sponsored cards marked with data-type="ad" / id="search-ad"', () => {
        const results = parseBraveResults(`<div id="results">${AD_CARD}${ORGANIC_CARD}</div>`, new Set<string>());

        expect(results).toHaveLength(1);
        expect(results[0].url).toBe('https://vuejs.org/');
        expect(results.some((r) => r.title.includes('Hotel Vue'))).toBe(false);
    });

    it('should skip relative redirect links (unusable for callers) even without ad markers', () => {
        const relativeCard = `
          <div class="snippet">
            <div class="result-content">
              <a href="/a/redirect?click_url=https%3A%2F%2Fexample.com%2Flanding">
                <span class="search-snippet-title">相对跳转条目</span>
              </a>
              <div class="generic-snippet">描述</div>
            </div>
          </div>`;

        const results = parseBraveResults(`<div id="results">${relativeCard}${ORGANIC_CARD}</div>`, new Set<string>());

        expect(results).toHaveLength(1);
        expect(results[0].url).toBe('https://vuejs.org/');
    });

    it('should keep parsing organic results after the ad card is skipped', () => {
        const results = parseBraveResults(`<div id="results">${AD_CARD}${ORGANIC_CARD}</div>`, new Set<string>());

        expect(results[0]).toMatchObject({
            title: 'Vue.js',
            source: 'vuejs.org',
            engine: 'brave'
        });
    });
});
