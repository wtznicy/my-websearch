import { describe, it, expect } from 'vitest';
import {
    parseDuckDuckGoJsonpPayload,
    parseDuckDuckGoHtmlResults,
    solveDuckDuckGoJsaChallenge
} from '../../engines/duckduckgo/searchDuckDuckGo.js';

const JSONP_PAYLOAD = `DDG.pageLayout.load('d', [{"t":"<b>MCP</b> title","u":"https://example.com/one","a":"desc with <b>bold</b>","i":"example.com"},{"t":"Second","u":"https://example.com/two","a":"<b>second</b> desc","sn":"source-org"},{"n":true,"t":"navigation item"}]);`;

const REAL_JSA_CHALLENGE = `window.execDeep = function() { 
let jsa = 973;
try {
let PcUrkYdu = function(num) {const el = document.createElement('div');el.innerHTML = \`<div><div></div><div></div\`;return num + el.innerHTML.length;};let BgTJaLJR = function(num) {const el = document.createElement('div');el.innerHTML = \`<li><div></li><li></div\`;return num + el.innerHTML.length;};let GSpNeQcZ = function(num) {const el = document.createElement('div');el.innerHTML = \`<div><div></div><div></div\`;return num + el.innerHTML.length;};let uKrynyKw = function(num) {const el = document.createElement('div');el.innerHTML = \`<p><div></p><p></div\`;return num + el.innerHTML.length;};let dQyekWwv = function(num) {return num * 3;};let VlPBxDiI = function(num) {const el = document.createElement('div');el.innerHTML = \`<p><div></p><p></div\`;return num + el.innerHTML.length;};jsa = uKrynyKw(jsa);jsa = BgTJaLJR(jsa);jsa = dQyekWwv(jsa);jsa = GSpNeQcZ(jsa);jsa = VlPBxDiI(jsa);jsa = PcUrkYdu(jsa);
} catch (e) { jsa = -1; }

DDG.deep.initialize('/d.js?q=model%20context%20protocol&t=A&l=us-en&s=0&dp=H6fVT8bhXJT&jsa_hash=ac5ead55c2764494f1b2e4a122851a97&jsa=' + jsa, false);
    
return {isJsaChallenge: true};
};`;

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

describe('solveDuckDuckGoJsaChallenge', () => {
    it('should solve real HTTP 202 isJsaChallenge (window.execDeep) HTML5 + math challenge', () => {
        const solvedUrl = solveDuckDuckGoJsaChallenge(REAL_JSA_CHALLENGE);
        expect(solvedUrl).not.toBeNull();
        expect(solvedUrl).toContain('https://links.duckduckgo.com/d.js?');
        expect(solvedUrl).toContain('jsa_hash=ac5ead55c2764494f1b2e4a122851a97');
        // 各步用 HTML5 规范解析（浏览器/jsdom 一致）补全残缺标签后的 innerHTML 长度：
        //   uKrynyKw(973)  '<p><div></p><p></div'             → 973 + 32 = 1005
        //   BgTJaLJR(1005) '<li><div></li><li></div'          → 1005 + 29 = 1034
        //   dQyekWwv(1034) * 3                                → 3102
        //   GSpNeQcZ(3102) '<div><div></div><div></div'       → 3102 + 33 = 3135
        //   VlPBxDiI(3135) '<p><div></p><p></div'             → 3135 + 32 = 3167
        //   PcUrkYdu(3167) '<div><div></div><div></div'       → 3167 + 33 = 3200
        // （首版断言写成 3180 是手算长度有误：漏了 32/33 的差别；jsdom 与 cheerio 复算均为 3200）
        expect(solvedUrl).toContain('&jsa=3200');
    });

    it('should reject untrusted host or non-JSA payload', () => {
        expect(solveDuckDuckGoJsaChallenge('DDG.deep.anomalyDetectionBlock()')).toBeNull();
        const evilScript = REAL_JSA_CHALLENGE.replace(
            "DDG.deep.initialize('/d.js?",
            "DDG.deep.initialize('https://evil.example.com/d.js?"
        );
        expect(solveDuckDuckGoJsaChallenge(evilScript)).toBeNull();
    });
});


describe('solveDuckDuckGoJsaChallenge：静态解析（不执行远端脚本）', () => {
    const REAL = REAL_JSA_CHALLENGE;

    it('恶意脚本体不会被求值（旧实现会经 constructor 链逃逸到宿主）', () => {
        // 把一处 helper 体替换成逃逸尝试：静态解析应直接拒绝（返回 null），而不是执行它
        const malicious = REAL.replace(
            "let dQyekWwv = function(num) {return num * 3;};",
            "let dQyekWwv = function(num) { return window.constructor.constructor('return process')().pid; };"
        );
        expect(solveDuckDuckGoJsaChallenge(malicious)).toBeNull();
    });

    it('未识别的 helper 形状应拒绝解析（宁可不解，也不猜）', () => {
        const weird = REAL.replace(
            "let dQyekWwv = function(num) {return num * 3;};",
            "let dQyekWwv = function(num) { return num ^ 3; };"
        );
        expect(solveDuckDuckGoJsaChallenge(weird)).toBeNull();
    });

    it('支持 `num * K` 与后缀拼接等变体', () => {
        const variant = [
            'window.execDeep = function() { let jsa = 10;',
            'let twice = function(num) { return num * 2; };',
            'let addFrag = function(num) { const el = document.createElement("div"); el.innerHTML = `<p><div></p><p></div`; return num + el.innerHTML.length; };',
            'jsa = twice(jsa); jsa = addFrag(jsa);',
            "DDG.deep.initialize('/d.js?q=x&jsa_hash=deadbeef&jsa=' + jsa + '&extra=1', false);",
            'return {isJsaChallenge: true}; };'
        ].join('\n');
        const solved = solveDuckDuckGoJsaChallenge(variant);

        expect(solved).not.toBeNull();
        expect(solved).toContain('jsa_hash=deadbeef');
        // 10 * 2 = 20，加段 `<p><div></p><p></div` 的规范化长度 32 → 52
        expect(solved).toContain('&jsa=52');
        expect(solved).toContain('&extra=1');
    });

    it('非挑战脚本 / 非法参数一律返回 null', () => {
        expect(solveDuckDuckGoJsaChallenge('')).toBeNull();
        expect(solveDuckDuckGoJsaChallenge('DDG.deep.anomalyDetectionBlock()')).toBeNull();
        expect(solveDuckDuckGoJsaChallenge(REAL.replace('window.execDeep', 'window.otherFn'))).toBeNull();
    });
});
