import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebFetchService } from '../../core/fetch/fetchServices.js';
import { getGlobalPageCache } from '../../core/fetch/pageCache.js';
import type { FetchWebContentResult } from '../../engines/web/fetchWebContent.js';

/**
 * P0-1 回归：缓存写入失败不能拖垮已经成功的抓取。
 * 以前 pageCache.set 是裸调用，磁盘满 / SQLITE_BUSY / 权限失败会让整次请求报错。
 */
const makeFetcher = (content: string) => async (url: string): Promise<FetchWebContentResult> => ({
    url,
    finalUrl: url,
    contentType: 'text/markdown',
    title: 'Cache write failure fixture',
    retrievalMethod: 'request',
    truncated: false,
    content,
    totalLength: content.length,
    startIndex: 0
});

describe('fetch pipeline cache write failures', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('still returns the fetched content when pageCache.set throws', async () => {
        const cache = getGlobalPageCache();
        vi.spyOn(cache, 'set').mockImplementation(() => {
            throw new Error('disk full (simulated)');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const service = createWebFetchService(makeFetcher('hello world '.repeat(50)));
        const result = await service.execute({
            url: `https://example.com/cache-write-failure-${Date.now()}`,
            maxChars: 200
        });

        expect(result.content.length).toBeGreaterThan(0);
        expect(result.content).toContain('hello world');
    });
});
