import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { searchBingWithHttp, isBingRedirectError } from '../../engines/bing/httpSearch.js';
import { getEffectiveBingBaseUrl, resetEffectiveBingBaseUrl } from '../../engines/bing/query.js';
import * as impersonateModule from '../../engines/bing/impersonate.js';
import { isEngineBrowserOnly } from '../../core/search/engineBrowserOnly.js';
import { config } from '../../config.js';

const mockHtmlWithResults = `
<!DOCTYPE html>
<html>
<body>
  <ol id="b_results">
    <li class="b_algo">
      <h2><a href="https://example.com/test-result">Test Title</a></h2>
      <div class="b_caption"><p>Test Description</p></div>
    </li>
  </ol>
</body>
</html>
`;

describe('Bing HTTP 301 redirect graceful fallback', () => {
    const originalBingBaseUrl = config.bingBaseUrl;

    beforeEach(() => {
        resetEffectiveBingBaseUrl();
        config.bingBaseUrl = 'https://cn.bing.com/search';
        vi.spyOn(impersonateModule, 'isImpersonateAvailable').mockResolvedValue(false);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetEffectiveBingBaseUrl();
        config.bingBaseUrl = originalBingBaseUrl;
    });

    it('identifies 301/302 redirect errors accurately', () => {
        expect(isBingRedirectError(Object.assign(new Error('Request failed with status code 301'), { status: 301 }))).toBe(true);
        expect(isBingRedirectError(Object.assign(new Error('Request failed with status code 302'), { status: 302 }))).toBe(true);
        expect(isBingRedirectError(new Error('Redirect detected'))).toBe(true);
        expect(isBingRedirectError(new Error('Network timeout'))).toBe(false);
        expect(isBingRedirectError({ status: 500 })).toBe(false);
    });

    it('automatically falls back to www.bing.com/search via HTTP on 301 and remembers it', async () => {
        const requestedUrls: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            requestedUrls.push(url);
            if (url.includes('cn.bing.com')) {
                const err = new Error('Request failed with status code 301');
                Object.assign(err, { status: 301, response: { status: 301 } });
                throw err;
            }
            return {
                data: mockHtmlWithResults,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as any
            };
        });

        expect(getEffectiveBingBaseUrl()).toBe('https://cn.bing.com/search');
        expect(isEngineBrowserOnly('bing')).toBe(false);

        // 第一次搜索：遭遇 301，自动降级为 www.bing.com/search 重试
        const results = await searchBingWithHttp('Vitest', 1);
        expect(results).toHaveLength(1);
        expect(results[0]?.title).toBe('Test Title');
        expect(results[0]?.url).toBe('https://example.com/test-result');

        // 验证请求历史：第一次 cn.bing.com，第二次自动切为 www.bing.com
        expect(requestedUrls).toHaveLength(2);
        expect(requestedUrls[0]).toContain('cn.bing.com/search');
        expect(requestedUrls[1]).toContain('www.bing.com/search');

        // 验证 effectiveBingBaseUrl 已被更新记忆
        expect(getEffectiveBingBaseUrl()).toBe('https://www.bing.com/search');
        // 绝不开启 180s 软窗口
        expect(isEngineBrowserOnly('bing')).toBe(false);

        // 第二次搜索：后续请求直接使用 www.bing.com/search，无需再撞 301
        requestedUrls.length = 0;
        const resultsSecond = await searchBingWithHttp('Next.js', 1);
        expect(resultsSecond).toHaveLength(1);
        expect(requestedUrls).toHaveLength(1);
        expect(requestedUrls[0]).toContain('www.bing.com/search');
    });
});
