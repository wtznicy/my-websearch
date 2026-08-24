import { describe, it, expect } from 'vitest';
import { parseSogouSearchResults } from '../../engines/sogou/sogou.js';

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
