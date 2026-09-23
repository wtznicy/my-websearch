import { describe, it, expect } from 'vitest';
import { parseSogouSearchResults, parseSogouMobileResults } from '../../engines/sogou/sogou.js';

const NORMAL_PAGE = `<!DOCTYPE html>
<html>
<head><title>websearch mcp - 搜狗搜索</title></head>
<body>
<div id="main">
  <div class="vrwrap">
    <h3 class="vr-title"><a href="https://www.sogou.com/link?url=encrypted1">第一个结果</a></h3>
    <div class="str_info">这是第一条描述</div>
    <cite>example.com</cite>
  </div>
  <div class="vrwrap">
    <h3 class="vr-title"><a href="https://example.com/direct">第二个结果</a></h3>
    <div class="text-layout">第二条描述</div>
    <cite>example.org</cite>
  </div>
</div>
</body>
</html>`;

// 描述尾部带 "站点名https://..." 形式的 footer，应从首个 http(s):// 截断
const FOOTER_NOISE_PAGE = `<!DOCTYPE html>
<html><body>
<div id="main">
  <div class="rb">
    <h3 class="pt"><a href="https://example.com/p">带噪声结果</a></h3>
    <div class="ft">这是描述站点名https://example.com/p 2026-08-01</div>
    <cite>example.com</cite>
  </div>
</div>
</body></html>`;

describe('parseSogouSearchResults', () => {
    it('should parse titles, urls, descriptions and sources', () => {
        const results = parseSogouSearchResults(NORMAL_PAGE);

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            title: '第一个结果',
            url: 'https://www.sogou.com/link?url=encrypted1',
            description: '这是第一条描述',
            source: 'example.com',
            engine: 'sogou'
        });
        expect(results[1].url).toBe('https://example.com/direct');
        expect(results[1].source).toBe('example.org');
    });

    it('should truncate description at the first http(s):// footer noise', () => {
        const results = parseSogouSearchResults(FOOTER_NOISE_PAGE);
        expect(results[0].description).toBe('这是描述站点名');
    });

    it('should throw on anti-spider challenge page', () => {
        expect(() => parseSogouSearchResults('<html><head><title>搜狗搜索验证</title></head><body>请输入验证码</body></html>'))
            .toThrow(/anti-bot/i);
        expect(() => parseSogouSearchResults('<html><body>antispider 访问过于频繁</body></html>'))
            .toThrow(/anti-bot/i);
    });

    it('should return empty array for page without result containers', () => {
        expect(parseSogouSearchResults('<html><body>no results</body></html>')).toEqual([]);
    });
});
const MOBILE_PAGE = `<!DOCTYPE html><html><body>
<div class="vrResult" id="sogou_vr_1">
  <h3><a class="resultLink" href="/web/searchList.jsp?keyword=x&url=https%3A%2F%2Fwww.cnblogs.com%2Fvkdoc%2Fp%2F19775542">博客园结果</a></h3>
  <div class="text-layout">博客园的描述文本</div>
</div>
<div class="vrResult" id="sogou_vr_2">
  <h3>广告位（无 resultLink）</h3>
</div>
<div class="vrResult" id="sogou_vr_3">
  <h3><a class="resultLink" href="/web/searchList.jsp?keyword=x&url=https%3A%2F%2Fm.sogou.com%2Fnav">搜狗自身导航（应被过滤）</a></h3>
</div>
</body></html>`;

describe('parseSogouMobileResults', () => {
    it('should extract real links from the url= parameter and skip ads/self-links', () => {
        const results = parseSogouMobileResults(MOBILE_PAGE);
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            title: '博客园结果',
            url: 'https://www.cnblogs.com/vkdoc/p/19775542',
            description: '博客园的描述文本',
            source: 'www.cnblogs.com',
            engine: 'sogou'
        });
    });

    it('should throw on a mobile verification page', () => {
        expect(() => parseSogouMobileResults('<html><title>搜狗搜索验证</title>请输入验证码</html>')).toThrow(/anti-bot/i);
    });
});
