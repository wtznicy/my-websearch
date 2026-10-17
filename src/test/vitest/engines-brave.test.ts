import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    parseBraveResults,
    parseBraveOfficialResults,
    cleanBraveApiText,
    isBraveOfficialApiDisabled,
    disableBraveOfficialApi,
    resetBraveOfficialApiCooldown,
    getBraveOfficialApiCooldownRemainingMs
} from '../../engines/brave/brave.js';

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

describe('cleanBraveApiText', () => {
    it('should strip HTML tags and resolve entities', () => {
        expect(cleanBraveApiText('<strong>DeepSeek</strong> &amp; <em>V3</em> &quot;AI&quot;')).toBe('DeepSeek & V3 "AI"');
    });

    it('should collapse multiple whitespaces', () => {
        expect(cleanBraveApiText('  hello   \n\t world  ')).toBe('hello world');
    });
});

describe('parseBraveOfficialResults', () => {
    it('should parse official Brave API response structure', () => {
        const mockResponse = {
            web: {
                results: [
                    {
                        title: '<strong>DeepSeek-V3</strong>',
                        url: 'https://github.com/deepseek-ai/DeepSeek-V3',
                        description: 'DeepSeek-V3 achieved a significant milestone.',
                        page_age: '2026-10-15T00:09:10',
                        profile: {
                            name: 'GitHub',
                            url: 'https://github.com'
                        },
                        meta_url: {
                            hostname: 'github.com'
                        },
                        extra_snippets: [
                            '671B parameters total.'
                        ]
                    },
                    {
                        title: 'DeepSeek Official Site',
                        url: 'https://www.deepseek.com',
                        description: 'Into the unknown.',
                        age: '2026-01-20'
                    }
                ]
            }
        };

        const seenUrls = new Set<string>();
        const results = parseBraveOfficialResults(mockResponse, seenUrls);

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({
            title: 'DeepSeek-V3',
            url: 'https://github.com/deepseek-ai/DeepSeek-V3',
            description: 'DeepSeek-V3 achieved a significant milestone. 671B parameters total.',
            source: 'github.com',
            engine: 'brave',
            date: '2026-10-15'
        });

        expect(results[1]).toEqual({
            title: 'DeepSeek Official Site',
            url: 'https://www.deepseek.com',
            description: 'Into the unknown.',
            source: 'www.deepseek.com',
            engine: 'brave',
            date: '2026-01-20'
        });
    });

    it('should dedupe urls using seenUrls', () => {
        const mockResponse = {
            web: {
                results: [
                    {
                        title: 'Duplicate URL',
                        url: 'https://github.com/deepseek-ai/DeepSeek-V3'
                    }
                ]
            }
        };
        const seenUrls = new Set<string>(['https://github.com/deepseek-ai/DeepSeek-V3']);
        const results = parseBraveOfficialResults(mockResponse, seenUrls);
        expect(results).toHaveLength(0);
    });

    it('should ignore non-http urls and missing title items', () => {
        const mockResponse = {
            web: {
                results: [
                    {
                        title: 'Bad URL',
                        url: 'javascript:void(0)'
                    },
                    {
                        title: '',
                        url: 'https://example.com'
                    }
                ]
            }
        };
        const seenUrls = new Set<string>();
        const results = parseBraveOfficialResults(mockResponse, seenUrls);
        expect(results).toHaveLength(0);
    });
});

describe('Brave official API cooldown and fallback state', () => {
    beforeEach(() => {
        resetBraveOfficialApiCooldown();
    });

    it('should be initially active (not disabled)', () => {
        expect(isBraveOfficialApiDisabled()).toBe(false);
        expect(getBraveOfficialApiCooldownRemainingMs()).toBe(0);
    });

    it('should track cooldown when disabled', () => {
        disableBraveOfficialApi(60000, 'Test reason');
        expect(isBraveOfficialApiDisabled()).toBe(true);
        expect(getBraveOfficialApiCooldownRemainingMs()).toBeGreaterThan(0);
    });

    it('should reset cooldown state when resetBraveOfficialApiCooldown is called', () => {
        disableBraveOfficialApi(60000, 'Test reason');
        expect(isBraveOfficialApiDisabled()).toBe(true);
        resetBraveOfficialApiCooldown();
        expect(isBraveOfficialApiDisabled()).toBe(false);
        expect(getBraveOfficialApiCooldownRemainingMs()).toBe(0);
    });

    it('cleanBraveApiText should handle &apos; and &#x27; entities properly', () => {
        expect(cleanBraveApiText('It&apos;s a user&#x27;s search')).toBe("It's a user's search");
    });
});
