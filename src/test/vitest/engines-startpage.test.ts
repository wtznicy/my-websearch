import { describe, it, expect } from 'vitest';
import { extractResultsFromHtml } from '../../engines/startpage/startpage.js';

const NORMAL_PAGE = `<!DOCTYPE html>
<html>
<head><title>my-websearch - Startpage</title></head>
<body>
<div class="result">
  <a class="result-title result-link" href="https://example.com/page-one">
    <h2>第一个结果</h2>
  </a>
  <p class="description">这是第一条描述</p>
</div>
<div class="result">
  <a class="result-title result-link" href="https://example.org/page-two">
    <h2>第二个结果</h2>
  </a>
  <p class="description">第二条描述</p>
</div>
</body>
</html>`;

describe('extractResultsFromHtml', () => {
    it('should parse titles, urls, descriptions and derive source from hostname', () => {
        const results = extractResultsFromHtml(NORMAL_PAGE);

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            title: '第一个结果',
            url: 'https://example.com/page-one',
            description: '这是第一条描述',
            source: 'example.com',
            engine: 'startpage'
        });
        expect(results[1].source).toBe('example.org');
    });

    it('should throw on captcha/verification page', () => {
        expect(() => extractResultsFromHtml('<html><head><title>Verify you are human</title></head><body>security check</body></html>'))
            .toThrow(/anti-bot/i);
        expect(() => extractResultsFromHtml('<html><body><form action="/sp/captcha"></form></body></html>'))
            .toThrow(/anti-bot/i);
    });

    it('should return empty array for page without result links', () => {
        expect(extractResultsFromHtml('<html><body>no results</body></html>')).toEqual([]);
    });
});
