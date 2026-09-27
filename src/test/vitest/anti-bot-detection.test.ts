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
        });

        it('returns false for ordinary technical content', () => {
            expect(looksLikeBotChallengePage('TypeScript tutorial for beginners with examples')).toBe(false);
        });
    });
});
