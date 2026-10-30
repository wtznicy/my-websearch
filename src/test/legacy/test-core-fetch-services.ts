import { FetchWebContentResult } from '../../engines/web/fetchWebContent.js';
import {
    createArticleFetchService,
    createGithubReadmeService,
    createWebFetchService
} from '../../core/fetch/fetchServices.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

async function testWebFetchService(): Promise<void> {
    let seenUrl = '';
    let seenMaxChars = 0;
    let seenReadability: boolean | undefined;
    let seenIncludeLinks: boolean | undefined;
    let seenRaw: boolean | undefined;
    let seenStartIndex: number | undefined;

    const service = createWebFetchService(async (url, maxChars, options) => {
        seenUrl = url;
        seenMaxChars = maxChars;
        seenReadability = options?.readability;
        seenIncludeLinks = options?.includeLinks;
        seenRaw = options?.raw;
        seenStartIndex = options?.startIndex;
        return {
            url,
            finalUrl: url,
            contentType: 'text/plain',
            title: 'Example',
            retrievalMethod: 'request',
            truncated: false,
            // 管线会按 startIndex 在「全文」上切片，因此夹具正文必须长于 startIndex，
            // 否则会抛 start_index_out_of_range（本用例验证的是参数是否被透传）
            content: `${'x'.repeat(200)}`,
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

    assertEqual(seenUrl, 'https://example.com/docs', 'web fetch forwards url');
    // 管线先向 fetcher 取全文（200000），再按调用方 maxChars/startIndex 切片，
    // 因此透传下去的 maxChars 恒为全文上限，而不是调用方请求值
    assertEqual(seenMaxChars, 200000, 'web fetch requests the full text before slicing');
    assertEqual(seenReadability, true, 'web fetch forwards readability');
    assertEqual(seenIncludeLinks, true, 'web fetch forwards includeLinks');
    assertEqual(seenRaw, true, 'web fetch forwards raw');
    // 同理：fetcher 永远从 0 开始取全文，startIndex 由切片阶段生效
    assertEqual(seenStartIndex, 0, 'web fetch starts the fetcher at offset 0');
    assertEqual(result.totalLength, 200, 'web fetch slices the fetched full text');
    assertEqual(result.readabilityApplied, true, 'web fetch returns delegate readability result');
    assertEqual(result.links?.[0]?.href, 'https://example.com/doc', 'web fetch returns delegate links');

    let invalidRejected = false;
    try {
        await service.execute({ url: 'http://127.0.0.1:3000', maxChars: 1000 });
    } catch {
        invalidRejected = true;
    }
    assert(invalidRejected, 'web fetch should reject private/local targets');

    console.log('✅ createWebFetchService');
}

async function testGithubReadmeService(): Promise<void> {
    let seenUrl = '';
    const service = createGithubReadmeService(async (url) => {
        seenUrl = url;
        return '# README';
    });

    const result = await service.execute({
        url: 'https://github.com/Aas-ee/open-webSearch'
    });

    assertEqual(seenUrl, 'https://github.com/Aas-ee/open-webSearch', 'github readme forwards url');
    assertEqual(result, '# README', 'github readme returns delegate result');

    let invalidRejected = false;
    try {
        await service.execute({ url: 'https://gitlab.com/Aas-ee/open-webSearch' });
    } catch {
        invalidRejected = true;
    }
    assert(invalidRejected, 'github readme should reject non-github url');

    console.log('✅ createGithubReadmeService');
}

async function testArticleFetchService(): Promise<void> {
    let seenUrl = '';
    const service = createArticleFetchService('juejin', async (url) => {
        seenUrl = url;
        return { content: 'article body' };
    });

    const result = await service.execute({
        url: 'https://juejin.cn/post/1234567890'
    });

    assertEqual(seenUrl, 'https://juejin.cn/post/1234567890', 'article fetch forwards url');
    assertEqual(result.content, 'article body', 'article fetch returns delegate result');

    let invalidRejected = false;
    try {
        await service.execute({ url: 'https://juejin.cn/pin/1234567890' });
    } catch {
        invalidRejected = true;
    }
    assert(invalidRejected, 'article fetch should reject invalid article url');

    console.log('✅ createArticleFetchService');
}

async function main(): Promise<void> {
    await testWebFetchService();
    await testGithubReadmeService();
    await testArticleFetchService();
    console.log('\nCore fetch service tests passed.');
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
