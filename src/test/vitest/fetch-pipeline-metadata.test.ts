import { describe, expect, it } from 'vitest';
import { createWebFetchService } from '../../core/fetch/fetchServices.js';
import type { FetchWebContentResult } from '../../engines/web/fetchWebContent.js';

/**
 * 回归保护：管线是「先取全文 → 再切片」的两段式，
 * 切片会重新组装结果对象，上游提取阶段的元数据（links / byline / readabilityApplied）
 * 必须显式透传，否则会静默消失（曾经真的消失过，`--include-links` 完全无效）。
 */

const LONG_BODY = `${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40)}`;

const makeResult = (overrides: Partial<FetchWebContentResult> = {}): FetchWebContentResult => ({
    url: 'https://example.com/article',
    finalUrl: 'https://example.com/article',
    contentType: 'text/markdown',
    title: 'Example Page',
    retrievalMethod: 'request',
    truncated: false,
    content: LONG_BODY,
    totalLength: LONG_BODY.length,
    startIndex: 0,
    ...overrides
});

describe('fetch pipeline metadata passthrough', () => {
    it('keeps links, byline and readabilityApplied from the delegate result', async () => {
        const service = createWebFetchService(async () => makeResult({
            links: [{ text: 'Doc', href: 'https://example.com/doc' }],
            byline: 'A. Writer',
            excerpt: 'A short summary.',
            readabilityApplied: true
        }));

        const result = await service.execute({
            url: 'https://example.com/article',
            maxChars: 500,
            readability: true,
            includeLinks: true
        });

        expect(result.links).toEqual([{ text: 'Doc', href: 'https://example.com/doc' }]);
        expect(result.byline).toBe('A. Writer');
        expect(result.excerpt).toBe('A short summary.');
        expect(result.readabilityApplied).toBe(true);
    });

    it('refetches for readability/includeLinks instead of serving a cached plain body', async () => {
        let calls = 0;
        const service = createWebFetchService(async () => {
            calls += 1;
            return makeResult();
        });

        const url = `https://example.com/cache-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        await service.execute({ url, maxChars: 500 });
        expect(calls).toBe(1);

        // 第二次同参数命中磁盘缓存（先证明缓存确实在工作，否则后面的断言没有意义）
        const cachedResult = await service.execute({ url, maxChars: 500 });
        expect(cachedResult.cached).toBe(true);
        expect(calls).toBe(1);

        // readability 是另一种提取方式，缓存键里没有它 → 必须重新抓取
        const readabilityResult = await service.execute({ url, maxChars: 500, readability: true });
        expect(readabilityResult.cached).toBe(false);
        expect(calls).toBe(2);

        // includeLinks 同理（缓存里没有 links 字段）
        await service.execute({ url, maxChars: 500, includeLinks: true });
        expect(calls).toBe(3);
    });
});
