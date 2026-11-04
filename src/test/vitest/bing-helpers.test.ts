import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
    __analyzeBlockedPageForTests,
    __buildBingBrowserLaunchArgsForTests,
    hasSiteOperator,
    shouldSuggestRemovingSiteOperator
} from '../../engines/bing/bing.js';
import { parseBingSearchResults } from '../../engines/bing/parser.js';

// 回归：新版结果页的 .b_tpcn 同时含站点名（.tptt）和可见 URL 文本节点，
// extractSource 若取整个 .b_tpcn 的 text() 会把两者拼成 "zhihu.comhttps://zhuanlan.zhihu.com"。
const sourceConcatHtml = `
<ol id="b_results">
  <li class="b_algo">
    <div class="b_tpcn">
      <a class="tilk" href="https://zhuanlan.zhihu.com/p/29001189476"><span class="tptt">zhihu.com</span></a>
      <div class="b_attribution" aria-label="zhuanlan.zhihu.com/p/29001189476">https://zhuanlan.zhihu.com</div>
    </div>
    <h2><a href="https://zhuanlan.zhihu.com/p/29001189476">MCP 一篇就够了</a></h2>
    <div class="b_snippet">A snippet.</div>
  </li>
</ol>`;

describe('Bing helpers', () => {
    it('keeps the .tptt site name without concatenating the URL slug', () => {
        const results = parseBingSearchResults(sourceConcatHtml, 5);
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('zhihu.com');
        expect(results[0].source).not.toContain('https://');
    });

    it('detects site: operator and suggests removing it on browser timeouts', () => {
        expect(hasSiteOperator('site:blink.new blink.new')).toBe(true);
        expect(hasSiteOperator('blink.new AI App Builder')).toBe(false);

        const timeout = new Error('page.waitForSelector: Timeout 15000ms exceeded.');
        expect(shouldSuggestRemovingSiteOperator('site:blink.new blink.new', timeout)).toBe(true);
        expect(shouldSuggestRemovingSiteOperator('blink.new AI App Builder', timeout)).toBe(false);
    });

    it('builds Windows/Linux launch args without unsupported flags', () => {
        const assertNoUnsupported = (args: string[]) => {
            for (const arg of args) {
                expect(arg.startsWith('--disable-')).toBe(false);
                expect(arg).not.toBe('--no-sandbox');
                expect(arg).not.toBe('--no-zygote');
            }
        };

        const windowsHeaded = __buildBingBrowserLaunchArgsForTests(false, 'win32');
        const windowsHidden = __buildBingBrowserLaunchArgsForTests(true, 'win32');
        assertNoUnsupported(windowsHeaded);
        assertNoUnsupported(windowsHidden);
        expect(windowsHidden).toContain('--window-position=-32000,-32000');
        expect(windowsHidden).toContain('--window-size=1,1');

        const linux = __buildBingBrowserLaunchArgsForTests(false, 'linux');
        expect(linux).toContain('--no-sandbox');
        expect(linux).toContain('--disable-setuid-sandbox');
        expect(linux).toContain('--disable-web-security');
    });

    it('classifies normal, fallback, captcha and empty pages', () => {
        const normalHtml = `<html><head><title>Bing</title></head><body>
            <ol id="b_results"><li class="b_algo"><h2><a href="https://example.com">Result</a></h2></li></ol>
        </body></html>`;
        expect(__analyzeBlockedPageForTests(cheerio.load(normalHtml), normalHtml)).toMatchObject({ hasResults: true, blocked: false });

        const fallbackHtml = `<html><head><title>Bing</title></head><body>
            <div id="b_results"><a href="https://fallback.example.com">Fallback Link</a></div>
        </body></html>`;
        expect(__analyzeBlockedPageForTests(cheerio.load(fallbackHtml), fallbackHtml)).toMatchObject({ hasResults: true, blocked: false });

        const captchaHtml = `<html><head><title>Please verify you are human</title></head><body>
            <div id="b_captcha">CAPTCHA</div>
        </body></html>`;
        const captcha = __analyzeBlockedPageForTests(cheerio.load(captchaHtml), captchaHtml);
        expect(captcha.hasResults).toBe(false);
        expect(captcha.blocked).toBe(true);
        expect(captcha.title).toContain('verify you are human');

        const emptyHtml = '<html><head><title>Bing</title></head><body></body></html>';
        expect(__analyzeBlockedPageForTests(cheerio.load(emptyHtml), emptyHtml)).toMatchObject({ hasResults: false, blocked: false });
    });

    it('discards relative /ck/a internal jump links', () => {
        const encoded = Buffer.from('https://relative-target.example.com/page').toString('base64url');
        const html = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="/ck/a?!&&p=abc&u=a1${encoded}&ntb=1">Relative CK Redirect Result</a></h2>
    <div class="b_caption"><p>Should be ignored.</p></div>
  </li>
</ol>`;
        expect(parseBingSearchResults(html, 5)).toHaveLength(0);
    });
});
