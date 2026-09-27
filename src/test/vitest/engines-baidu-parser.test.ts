import { describe, it, expect } from 'vitest';
import { parseBaiduResultsPage } from '../../engines/baidu/parser.js';

const BAIDU_FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head><title>测试_百度搜索</title></head>
<body>
<div id="content_left">
  <!-- 结果 1: 正常自然搜索结果 -->
  <div class="result c-container" tpl="se_com_default">
    <h3 class="t"><a href="https://example.com/item1">测试结果一 <em>高亮</em></a></h3>
    <div class="c-abstract">这是百度搜索结果一的摘要描述内容。</div>
    <div class="f13"><a class="c-showurl" href="#">example.com</a></div>
  </div>

  <!-- 结果 2: 带百科卡片的直接答案 -->
  <div class="result c-container" tpl="new_baikan">
    <h3><a href="https://baike.baidu.com/item/test">百度百科测试词条</a></h3>
    <div class="c-abstract">测试是一个汉语词汇，指在机器运行前对其性能进行测定。</div>
  </div>

  <!-- 结果 3: 广告推广（应被过滤） -->
  <div class="result c-container b_ad" tpl="se_com_default">
    <h3 class="t"><a href="https://www.baidu.com/baidu.php?url=ad123">广告推广链接</a></h3>
    <div class="c-abstract">推广内容描述</div>
  </div>

  <!-- 结果 4: 噪声模块（大家还在搜，应被过滤） -->
  <div class="c-container" tpl="recommend_list">
    <div>大家还在搜</div>
  </div>

  <!-- 结果 5: 另一个正常自然结果 -->
  <div class="result c-container" tpl="se_com_default">
    <h3 class="t"><a href="https://example.org/item2">第二个自然结果</a></h3>
    <div class="c-abstract">这是第二个自然结果的摘要内容。</div>
  </div>
</div>
</body>
</html>`;

describe('parseBaiduResultsPage', () => {
    it('parses organic results and ignores ads and noise modules', async () => {
        const seenUrls = new Set<string>();
        const results = await parseBaiduResultsPage(BAIDU_FIXTURE_HTML, seenUrls);

        // 结果应该包含 item1, baike, item2，且剔除广告与大家还在搜
        expect(results.length).toBeGreaterThanOrEqual(2);

        const titles = results.map((r) => r.title);
        expect(titles.some((t) => t.includes('测试结果一'))).toBe(true);
        expect(titles.some((t) => t.includes('第二个自然结果'))).toBe(true);
        expect(titles.some((t) => t.includes('广告推广链接'))).toBe(false);

        // 验证 directAnswer 提取到了百科卡片文本
        expect((results as any).directAnswer).toBeDefined();
        expect(typeof (results as any).directAnswer).toBe('string');
        expect((results as any).directAnswer).toContain('汉语词汇');
    });

    it('deduplicates results against seenUrls set', async () => {
        const seenUrls = new Set<string>(['https://example.com/item1']);
        const results = await parseBaiduResultsPage(BAIDU_FIXTURE_HTML, seenUrls);

        const urls = results.map((r) => r.url);
        expect(urls).not.toContain('https://example.com/item1');
    });

    it('returns empty array when content_left has no results', async () => {
        const emptyHtml = `<html><head><title>百度搜索</title></head><body><div id="content_left"></div></body></html>`;
        const results = await parseBaiduResultsPage(emptyHtml, new Set());
        expect(results).toEqual([]);
    });
});
