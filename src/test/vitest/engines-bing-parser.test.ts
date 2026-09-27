import { describe, it, expect } from 'vitest';
import { parseBingSearchResults } from '../../engines/bing/parser.js';

// Base64url for "https://example.com/decoded-target" is "aHR0cHM6Ly9leGFtcGxlLmNvbS9kZWNvZGVkLXRhcmdldA"
const ENCODED_BING_URL = 'https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9kZWNvZGVkLXRhcmdldA&ntb=1';

const BING_FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head><title>Bing Search</title></head>
<body>
<ol id="b_results">
  <!-- 结果 1: 正常结果 -->
  <li class="b_algo">
    <h2><a href="https://example.com/first">First Search Result</a></h2>
    <div class="b_caption">
      <p>This is the first description snippet with key information.</p>
      <div class="b_attribution"><cite>example.com</cite></div>
    </div>
  </li>

  <!-- 结果 2: 带 /ck/a 跳转链的结果 -->
  <li class="b_algo">
    <h2><a href="${ENCODED_BING_URL}">Redirect Encoded Result</a></h2>
    <div class="b_caption">
      <p>This result URL needs base64url decoding from u parameter.</p>
      <div class="b_attribution"><cite>example.com</cite></div>
    </div>
  </li>

  <!-- 结果 3: 广告（应被过滤） -->
  <li class="b_ad">
    <h2><a href="https://ad.example.com">Ad title</a></h2>
  </li>

  <!-- 结果 4: 分页导航（应被过滤） -->
  <li class="b_pag">
    <a href="#">Next Page</a>
  </li>

  <!-- 结果 5: 另一个正常结果 -->
  <li class="b_algo">
    <h2><a href="https://example.org/third">Third Search Result</a></h2>
    <div class="b_caption">
      <p>Another snippet for the third result.</p>
    </div>
  </li>
</ol>
</body>
</html>`;

describe('parseBingSearchResults', () => {
    it('parses Bing results, decodes /ck/a URLs, and ignores ads and pagination', () => {
        const results = parseBingSearchResults(BING_FIXTURE_HTML, 10);

        expect(results).toHaveLength(3);

        expect(results[0]).toMatchObject({
            title: 'First Search Result',
            url: 'https://example.com/first',
            description: 'This is the first description snippet with key information.',
            engine: 'bing'
        });

        // 验证 /ck/a 链接被成功解码为真实目标 URL
        expect(results[1]).toMatchObject({
            title: 'Redirect Encoded Result',
            url: 'https://example.com/decoded-target',
            engine: 'bing'
        });

        expect(results[2]).toMatchObject({
            title: 'Third Search Result',
            url: 'https://example.org/third',
            engine: 'bing'
        });
    });

    it('respects limit parameter', () => {
        const results = parseBingSearchResults(BING_FIXTURE_HTML, 2);
        expect(results).toHaveLength(2);
    });

    it('returns empty array when no result items exist', () => {
        const results = parseBingSearchResults('<html><body><ol id="b_results"></ol></body></html>', 5);
        expect(results).toEqual([]);
    });
});
