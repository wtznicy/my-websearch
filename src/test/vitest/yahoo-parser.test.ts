import { describe, expect, it } from 'vitest';
import { extractYahooResultUrl, parseYahooHtmlResults } from '../../engines/yahoo/yahoo.js';

/**
 * 回归：Yahoo 的结果链接是 r.search.yahoo.com 的 RU= 重定向，
 * 且标题在 h3、链接在 h3 外层的 .compTitle > a（不能写 h3 a）。
 */
describe('Yahoo result URL extraction', () => {
    it('decodes the RU= redirect target', () => {
        expect(extractYahooResultUrl(
            'https://r.search.yahoo.com/_ylt=abc/RV=2/RE=1/RO=10/RU=https%3a%2f%2fexample.com%2Fdoc/RK=2/RS=xyz-'
        )).toBe('https://example.com/doc');
    });

    it('keeps direct URLs untouched', () => {
        expect(extractYahooResultUrl('https://example.com/a')).toBe('https://example.com/a');
    });
});

describe('parseYahooHtmlResults', () => {
    it('extracts title, decoded URL and snippet from div.algo', () => {
        const html = `
          <div class="dd fst algo algo-sr">
            <div class="compTitle options-toggle">
              <a href="https://r.search.yahoo.com/_ylt=abc/RV=2/RE=1/RO=10/RU=https%3a%2f%2fexample.com%2Fdoc/RK=2/RS=xyz-">
                <h3><span>Example doc</span></h3>
              </a>
            </div>
            <div class="compText"><p>A useful snippet.</p></div>
          </div>`;
        const parsed = parseYahooHtmlResults(html, 5, new Set());
        expect(parsed.results).toHaveLength(1);
        expect(parsed.results[0]).toMatchObject({
            title: 'Example doc',
            url: 'https://example.com/doc',
            description: 'A useful snippet.',
            engine: 'yahoo'
        });
    });
});
