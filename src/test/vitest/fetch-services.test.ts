import { describe, it, expect } from 'vitest';
import type { FetchWebContentResult } from '../../engines/web/fetchWebContent.js';
import {
    createArticleFetchService,
    createGithubReadmeService,
    createWebFetchService
} from '../../core/fetch/fetchServices.js';

describe('core/fetch fetchServices', () => {
    it('forwards web fetch options and slices the fetched full text', async () => {
        const seen: {
            url?: string;
            maxChars?: number;
            readability?: boolean;
            includeLinks?: boolean;
            raw?: boolean;
            startIndex?: number;
        } = {};

        const service = createWebFetchService(async (url, maxChars, options) => {
            seen.url = url;
            seen.maxChars = maxChars;
            seen.readability = options?.readability;
            seen.includeLinks = options?.includeLinks;
            seen.raw = options?.raw;
            seen.startIndex = options?.startIndex;
            return {
                url,
                finalUrl: url,
                contentType: 'text/plain',
                title: 'Example',
                retrievalMethod: 'request',
                truncated: false,
                content: 'x'.repeat(200),
                totalLength: 200,
                startIndex: options?.startIndex ?? 0,
                readabilityApplied: options?.readability ?? false,
                links: options?.includeLinks ? [{ text: 'Doc', href: 'https://example.com/doc' }] : undefined
            } satisfies FetchWebContentResult;
        });

        const result = await service.execute({
            url: 'https://example.com/docs',
            maxChars: 1234,
            readability: true,
            includeLinks: true,
            raw: true,
            startIndex: 100
        });

        expect(seen.url).toBe('https://example.com/docs');
        // 管线先取全文（200000）再按调用方 maxChars/startIndex 切片
        expect(seen.maxChars).toBe(200000);
        expect(seen.readability).toBe(true);
        expect(seen.includeLinks).toBe(true);
        expect(seen.raw).toBe(true);
        expect(seen.startIndex).toBe(0);
        expect(result.totalLength).toBe(200);
        expect(result.readabilityApplied).toBe(true);
        expect(result.links?.[0]?.href).toBe('https://example.com/doc');

        await expect(service.execute({ url: 'http://127.0.0.1:3000', maxChars: 1000 })).rejects.toThrow();
    });

    it('forwards GitHub readme URLs and rejects non-GitHub hosts', async () => {
        let seenUrl = '';
        const service = createGithubReadmeService(async (url) => {
            seenUrl = url;
            return '# README';
        });

        await expect(service.execute({ url: 'https://github.com/Aas-ee/open-webSearch' })).resolves.toBe('# README');
        expect(seenUrl).toBe('https://github.com/Aas-ee/open-webSearch');
        await expect(service.execute({ url: 'https://gitlab.com/Aas-ee/open-webSearch' })).rejects.toThrow();
    });

    it('forwards article URLs and rejects invalid article paths', async () => {
        let seenUrl = '';
        const service = createArticleFetchService('juejin', async (url) => {
            seenUrl = url;
            return { content: 'article body' };
        });

        const result = await service.execute({ url: 'https://juejin.cn/post/1234567890' });
        expect(seenUrl).toBe('https://juejin.cn/post/1234567890');
        expect(result.content).toBe('article body');
        await expect(service.execute({ url: 'https://juejin.cn/pin/1234567890' })).rejects.toThrow();
    });
});
