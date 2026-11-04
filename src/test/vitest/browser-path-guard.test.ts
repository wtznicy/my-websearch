import { describe, it, expect, afterEach } from 'vitest';
import {
    __getBrowserSubresourceClassificationForTests,
    __resetBrowserSubresourceCacheForTests,
    classifyBrowserSubresourceUrl,
    fetchPageHtmlWithBrowser,
    getBrowserCookieHeader
} from '../../utils/browserCookies.js';
import { __setDnsLookupForTests } from '../../utils/urlSafety.js';

const PRIVATE_PATTERN = /private or local network/;
const REBINDING_PATTERN = /private or local network|wildcard DNS|rebinding/i;

afterEach(() => {
    __resetBrowserSubresourceCacheForTests();
    __setDnsLookupForTests();
});

describe('browser path guard', () => {
    it('rejects literal private targets before navigation', async () => {
        for (const url of [
            'http://127.0.0.1/admin',
            'http://[::1]/admin',
            'http://169.254.169.254/latest/meta-data/'
        ]) {
            await expect(getBrowserCookieHeader(url)).rejects.toThrow(PRIVATE_PATTERN);
        }

        await expect(fetchPageHtmlWithBrowser('http://127.0.0.1/admin')).rejects.toThrow(PRIVATE_PATTERN);
        await expect(fetchPageHtmlWithBrowser('http://[::ffff:7f00:1]/admin')).rejects.toThrow(PRIVATE_PATTERN);
    });

    it('rejects rebinding-style hostnames before DNS resolution', async () => {
        await expect(getBrowserCookieHeader('http://127.0.0.1.nip.io/admin')).rejects.toThrow(REBINDING_PATTERN);
        await expect(fetchPageHtmlWithBrowser('http://127.0.0.1.nip.io/admin')).rejects.toThrow(REBINDING_PATTERN);
    });

    it('guards browser subresources and caches negative classifications', async () => {
        for (const url of [
            'http://127.0.0.1/internal.js',
            'http://[::1]/internal.js',
            'http://169.254.169.254/latest/meta-data/'
        ]) {
            await expect(classifyBrowserSubresourceUrl(url)).rejects.toThrow(PRIVATE_PATTERN);
        }

        await expect(classifyBrowserSubresourceUrl('http://127.0.0.1.nip.io/img.png')).rejects.toThrow(REBINDING_PATTERN);
        expect(__getBrowserSubresourceClassificationForTests('127.0.0.1.nip.io')).toBe(false);
        await expect(classifyBrowserSubresourceUrl('http://127.0.0.1.nip.io/img2.png')).rejects.toThrow(REBINDING_PATTERN);
    });

    it('allows and caches public subresources', async () => {
        __setDnsLookupForTests(async () => [{ address: '8.8.8.8' }]);
        await expect(classifyBrowserSubresourceUrl('http://8.8.8.8.nip.io/cdn/asset.css')).resolves.toBeUndefined();
        expect(__getBrowserSubresourceClassificationForTests('8.8.8.8.nip.io')).toBe(true);
        await expect(classifyBrowserSubresourceUrl('http://8.8.8.8.nip.io/cdn/other.js')).resolves.toBeUndefined();
    });
});
