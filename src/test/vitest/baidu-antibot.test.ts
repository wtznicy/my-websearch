import { describe, it, expect } from 'vitest';
import { isBaiduAntiBotPage, parseBaiduResultsPage } from '../../engines/baidu/parser.js';

// 反爬页 fixture：无 cookie 时百度返回的 <meta refresh> 跳转页（无结果容器）
const META_REFRESH_PAGE = `<!DOCTYPE html>
<html>
<head><meta http-equiv="refresh" content="0;url=https://www.baidu.com/s?wd=test&rsv_spt=1"></head>
<body></body>
</html>`;

// 安全验证页 fixture：wappass 跳转
const SECURITY_VERIFY_PAGE = `<!DOCTYPE html>
<html>
<head><title>百度安全验证</title></head>
<body><div>百度安全验证</div><script>location.href='https://wappass.baidu.com/static/captcha/turegg.html';</script></body>
</html>`;

// 正常结果页 fixture：只含直接链接（不触发中转链接的 HEAD 网络请求）
const NORMAL_RESULT_PAGE = `<!DOCTYPE html>
<html>
<head><title>websearch mcp - 百度搜索</title></head>
<body>
<div id="content_left">
  <div class="result">
    <h3 class="c-title no-abstract"><a href="https://example.com/one">第一个结果</a></h3>
    <div class="c-font-normal c-color-text">这是第一条描述</div>
  </div>
  <div class="result">
    <h3 class="c-title no-abstract"><a href="https://example.com/two">第二个结果</a></h3>
    <div class="cos-row">第二条描述</div>
  </div>
</div>
</body>
</html>`;

describe('isBaiduAntiBotPage', () => {
    it('should detect meta refresh redirect page (missing cookies)', () => {
        expect(isBaiduAntiBotPage(META_REFRESH_PAGE)).toBe(true);
    });

    it('should detect security verification page', () => {
        expect(isBaiduAntiBotPage(SECURITY_VERIFY_PAGE)).toBe(true);
    });

    it('should NOT flag a normal results page', () => {
        expect(isBaiduAntiBotPage(NORMAL_RESULT_PAGE)).toBe(false);
    });

    it('should NOT flag empty page without refresh/security signals', () => {
        expect(isBaiduAntiBotPage('<!DOCTYPE html><html><body><p>no results</p></body></html>')).toBe(false);
    });
});

describe('parseBaiduResultsPage', () => {
    it('should extract titles, urls and descriptions, and dedupe by url', async () => {
        const seenUrls = new Set<string>();
        const results = await parseBaiduResultsPage(NORMAL_RESULT_PAGE, seenUrls);

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            title: '第一个结果',
            url: 'https://example.com/one',
            description: '这是第一条描述',
            engine: 'baidu'
        });
        expect(results[1]).toMatchObject({
            title: '第二个结果',
            url: 'https://example.com/two',
            description: '第二条描述'
        });
    });

    it('should skip urls already seen across pages', async () => {
        const seenUrls = new Set<string>(['https://example.com/one']);
        const results = await parseBaiduResultsPage(NORMAL_RESULT_PAGE, seenUrls);

        expect(results).toHaveLength(1);
        expect(results[0].url).toBe('https://example.com/two');
    });

    it('should return empty array for a page without result containers', async () => {
        const results = await parseBaiduResultsPage('<html><body>no results</body></html>', new Set<string>());
        expect(results).toEqual([]);
    });
});
