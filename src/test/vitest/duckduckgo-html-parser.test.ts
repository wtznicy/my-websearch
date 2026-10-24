import { describe, expect, it } from 'vitest';
import { parseDuckDuckGoHtmlResults, resolveDuckDuckGoResultUrl } from '../../engines/duckduckgo/searchDuckDuckGo.js';

/**
 * 回归：DDG HTML 结果的 href 是协议相对的重定向链接
 * (`//duckduckgo.com/l/?uddg=...`)，不还原会被 normalizeSearchResult 丢掉，表现为 0 条。
 */
describe('DuckDuckGo HTML URL resolution', () => {
    it('decodes protocol-relative /l/?uddg= redirects', () => {
        expect(resolveDuckDuckGoResultUrl(
            '//duckduckgo.com/l/?uddg=https%3A%2F%2Ftokio.rs%2Ftokio%2Ftutorial%2Fasync&rut=abc'
        )).toBe('https://tokio.rs/tokio/tutorial/async');
    });

    it('handles the /l/ path form', () => {
        expect(resolveDuckDuckGoResultUrl(
            '/l/?uddg=https%3A%2F%2Fexample.com%2Fpost'
        )).toBe('https://example.com/post');
    });

    it('keeps absolute URLs untouched', () => {
        expect(resolveDuckDuckGoResultUrl('https://example.com/a')).toBe('https://example.com/a');
    });
});

describe('parseDuckDuckGoHtmlResults', () => {
    it('extracts results with decoded target URLs', () => {
        const html = `
          <div class="result">
            <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Example doc</a></h2>
            <a class="result__snippet">A useful snippet.</a>
            <span class="result__url">example.com</span>
          </div>`;
        const parsed = parseDuckDuckGoHtmlResults(html, 5, new Set());
        expect(parsed.results).toHaveLength(1);
        expect(parsed.results[0]).toMatchObject({
            title: 'Example doc',
            url: 'https://example.com/doc',
            description: 'A useful snippet.'
        });
    });
});
