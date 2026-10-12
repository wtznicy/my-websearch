import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
    isBaiduAntiBotPage,
    isBingAntiBotPage,
    analyzeBingBlockedPage,
    isBraveBlockedPage,
    isSogouChallengePage,
    isStartpageCaptchaPage,
    looksLikeBotChallengePage
} from '../../core/antiBot/antiBotDetection.js';

describe('antiBotDetection', () => {
    describe('isBaiduAntiBotPage', () => {
        it('detects wappass or security challenge keywords', () => {
            expect(isBaiduAntiBotPage('<html><head><title>百度安全验证</title></head><body>请完成验证码</body></html>')).toBe(true);
            expect(isBaiduAntiBotPage('<html><body><script>location.href="https://wappass.baidu.com/static/captcha"</script></body></html>')).toBe(true);
        });

        it('detects meta refresh when content_left results container is absent', () => {
            const html = `<html><head><meta http-equiv="refresh" content="0;url=https://www.baidu.com"></head><body>empty</body></html>`;
            expect(isBaiduAntiBotPage(html)).toBe(true);
        });

        it('returns false for normal Baidu search result page', () => {
            const html = `<html><head><title>TypeScript_百度搜索</title></head><body><div id="content_left"><div class="result">Content</div></div></body></html>`;
            expect(isBaiduAntiBotPage(html)).toBe(false);
        });
    });

    describe('isBingAntiBotPage & analyzeBingBlockedPage', () => {
        it('identifies Bing captcha challenge in title when b_algo results are absent', () => {
            const html = `<html><head><title>Verify you are human - Bing</title></head><body><div id="b_captcha"></div></body></html>`;
            expect(isBingAntiBotPage(html)).toBe(true);
        });

        it('returns false for normal Bing result page', () => {
            const html = `<html><head><title>TypeScript - Search</title></head><body><ol id="b_results"><li class="b_algo"><h2><a href="https://ts.org">TS</a></h2></li></ol></body></html>`;
            expect(isBingAntiBotPage(html)).toBe(false);

            const $ = cheerio.load(html);
            const analysis = analyzeBingBlockedPage($, html);
            expect(analysis.blocked).toBe(false);
            expect(analysis.hasResults).toBe(true);
        });

        it('analyzeBingBlockedPage detects blocked state with captcha UI', () => {
            const html = `<html><head><title>Bing</title></head><body><div id="b_captcha"><iframe src="https://captcha.bing.com"></iframe></div></body></html>`;
            const $ = cheerio.load(html);
            const analysis = analyzeBingBlockedPage($, html);
            expect(analysis.blocked).toBe(true);
            expect(analysis.hasResults).toBe(false);
        });
    });

    describe('isBraveBlockedPage', () => {
        it('detects access denied or captcha in Brave title', () => {
            expect(isBraveBlockedPage('<html><head><title>Access Denied | Brave Search</title></head></html>')).toBe(true);
            expect(isBraveBlockedPage('<html><head><title>Unusual Traffic | Brave</title></head></html>')).toBe(true);
        });

        it('returns false for normal Brave search page', () => {
            expect(isBraveBlockedPage('<html><head><title>TypeScript at Brave Search</title></head></html>')).toBe(false);
        });
    });

    describe('isSogouChallengePage', () => {
        it('detects antispider and verification title', () => {
            expect(isSogouChallengePage('<html><head><title>搜狗搜索验证</title></head><body>请输入验证码</body></html>')).toBe(true);
            expect(isSogouChallengePage('<html><body><div class="antispider">访问过于频繁</div></body></html>')).toBe(true);
        });

        it('returns false for normal Sogou result page', () => {
            expect(isSogouChallengePage('<html><head><title>TypeScript - 搜狗搜索</title></head><body><div class="results">...</div></body></html>')).toBe(false);
        });
    });

    describe('isStartpageCaptchaPage', () => {
        it('detects Startpage captcha URL and form action', () => {
            expect(isStartpageCaptchaPage('<html><body><form action="/sp/captcha" method="POST"></form></body></html>')).toBe(true);
            expect(isStartpageCaptchaPage('<html><head><title>Security Check</title></head><body>Please verify you are human</body></html>')).toBe(true);
        });

        it('returns false for normal Startpage result page', () => {
            expect(isStartpageCaptchaPage('<html><head><title>TypeScript - Startpage Search</title></head><body><div class="w-gl">Result</div></body></html>')).toBe(false);
        });
    });

    describe('looksLikeBotChallengePage', () => {
        it('identifies generic challenge signatures', () => {
            expect(looksLikeBotChallengePage('Please solve the captcha to continue')).toBe(true);
            expect(looksLikeBotChallengePage('系统检测到异常访问，请完成安全验证')).toBe(true);
            expect(looksLikeBotChallengePage('你似乎来到了没有知识存在的荒原 - 知乎')).toBe(true);
            expect(looksLikeBotChallengePage('没有知识存在的荒原')).toBe(true);
        });

        it('returns false for ordinary technical content and short technical documentation phrases', () => {
            expect(looksLikeBotChallengePage('TypeScript tutorial for beginners with examples')).toBe(false);
            expect(looksLikeBotChallengePage('知识图谱构建与自然语言处理实战')).toBe(false);

            const negativeDocs = [
                'Email verification API guide',
                'How to build a captcha component',
                'Verification token documentation',
                'Access denied middleware configuration',
                'Rate limit handling in SDK documentation'
            ];
            for (const doc of negativeDocs) {
                expect(looksLikeBotChallengePage(doc)).toBe(false);
                expect(
                    looksLikeBotChallengePage(
                        `<html><head><title>${doc}</title></head><body><main><h1>${doc}</h1><p>Configure ${doc.toLowerCase()} in your service.</p></main></body></html>`,
                        { status: 200 }
                    )
                ).toBe(false);
            }
        });

        it('detects composite signals (abnormal HTTP status + missing main container + short body or script/meta challenge markers)', () => {
            // Cloudflare / WAF script challenge marker without obvious body text
            const cfScriptHtml = `<html><head><title> Example </title><script>window._cf_chl_opt={cvId: '2'};</script></head><body><div>Loading...</div></body></html>`;
            expect(looksLikeBotChallengePage(cfScriptHtml)).toBe(true);

            // Aliyun WAF / Geetest script challenge marker
            const wafScriptHtml = `<html><head><script src="https://static.geetest.com/v4/gt4.js"></script></head><body><div>请稍候</div></body></html>`;
            expect(looksLikeBotChallengePage(wafScriptHtml)).toBe(true);

            // Meta refresh to captcha page
            const metaRefreshHtml = `<html><head><meta http-equiv="refresh" content="0;url=/captcha/verify"></head><body></body></html>`;
            expect(looksLikeBotChallengePage(metaRefreshHtml)).toBe(true);

            // Abnormal HTTP 403 + short body + generic WAF/Cloudflare wording without expected article container
            const status403WafHtml = `<html><head><title>403</title></head><body><p>Request blocked by Cloudflare WAF.</p></body></html>`;
            expect(looksLikeBotChallengePage(status403WafHtml, { status: 403 })).toBe(true);

            // Long article discussing Cloudflare WAF and captcha with status 200 must NOT be flagged
            const longArticleHtml = `<html><head><title>Cloudflare WAF and Captcha Guide</title></head><body><article><p>${'In this tutorial we explain how Cloudflare WAF and captcha verification work in production APIs. '.repeat(6)}</p></article></body></html>`;
            expect(looksLikeBotChallengePage(longArticleHtml, { status: 200 })).toBe(false);
        });
    });
});

