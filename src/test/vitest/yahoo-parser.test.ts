import { describe, expect, it } from 'vitest';
import { extractYahooResultUrl, parseYahooHtmlResults, __isProxyOrNetworkFatalErrorForTests, hasYahooSessionCookie } from '../../engines/yahoo/yahoo.js';

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

describe('Yahoo fatal proxy/network error detection', () => {
    it('detects unexpected EOF and connection reset errors as fatal proxy errors', () => {
        expect(__isProxyOrNetworkFatalErrorForTests(new Error('client error (Connect): unexpected EOF'))).toBe(true);
        expect(__isProxyOrNetworkFatalErrorForTests(new Error('Client network socket disconnected before secure TLS connection was established'))).toBe(true);
        expect(__isProxyOrNetworkFatalErrorForTests(new Error('read ECONNRESET'))).toBe(true);
        expect(__isProxyOrNetworkFatalErrorForTests(new Error('socket hang up'))).toBe(true);
        expect(__isProxyOrNetworkFatalErrorForTests(new Error('operation timed out'))).toBe(true);
        expect(__isProxyOrNetworkFatalErrorForTests(new Error('schannel: failed to receive handshake, SSL/TLS connection failed'))).toBe(true);
    });

    it('does not classify standard HTTP errors or parsing errors as fatal network errors', () => {
        expect(__isProxyOrNetworkFatalErrorForTests(new Error('HTTP 404 Not Found'))).toBe(false);
        expect(__isProxyOrNetworkFatalErrorForTests(new Error('Invalid HTML received'))).toBe(false);
        expect(__isProxyOrNetworkFatalErrorForTests(null)).toBe(false);
    });
});

describe('hasYahooSessionCookie', () => {
    it('returns true when essential Yahoo session cookies are present', () => {
        expect(hasYahooSessionCookie([{ name: 'A1' }])).toBe(true);
        expect(hasYahooSessionCookie([{ name: 'a3' }])).toBe(true);
        expect(hasYahooSessionCookie([{ name: 'lkl' }])).toBe(true);
        expect(hasYahooSessionCookie([{ name: 'B' }])).toBe(true);
        expect(hasYahooSessionCookie([{ name: 'other' }, { name: 'BX' }])).toBe(true);
    });

    it('returns false when no essential cookies match or list is empty', () => {
        expect(hasYahooSessionCookie([])).toBe(false);
        expect(hasYahooSessionCookie([{ name: 'test' }, { name: 'sid' }])).toBe(false);
        expect(hasYahooSessionCookie([{}])).toBe(false);
    });
});
