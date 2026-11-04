import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { config } from '../../config.js';
import {
    __setBrowserCookieHeaderForTests,
    __setBrowserHtmlFetcherForTests,
    __setReadabilityParserForTests,
    fetchWebContent
} from '../../engines/web/fetchWebContent.js';
import { __setAxiosRequestForTests } from '../../utils/httpRequest.js';
import { __setDnsLookupForTests } from '../../utils/urlSafety.js';

const requestAttempts = new Map<string, number>();
const requestConfigs = new Map<string, any[]>();
let originalInsecureTls: boolean;

function makeResponse(
    config: AxiosRequestConfig,
    response: { status?: number; headers?: Record<string, string>; data?: unknown; finalUrl?: string }
): AxiosResponse {
    return {
        status: response.status ?? 200,
        statusText: '',
        headers: response.headers ?? {},
        data: response.data ?? '',
        config,
        request: { res: { responseUrl: response.finalUrl ?? config.url } }
    } as AxiosResponse;
}

function installAxiosMock(): void {
    requestAttempts.clear();
    requestConfigs.clear();

    __setAxiosRequestForTests(async (config) => {
        const url = String(config.url || '');
        const method = String(config.method || 'GET').toUpperCase();
        const configs = requestConfigs.get(url) || [];
        configs.push({ method, options: config });
        requestConfigs.set(url, configs);

        if (method === 'HEAD') {
            if (url.endsWith('/too-large.md')) {
                return makeResponse(config, { headers: { 'content-length': String(5 * 1024 * 1024) }, finalUrl: url });
            }
            if (url.endsWith('/long.md')) {
                return makeResponse(config, { headers: { 'content-length': String(1024) }, finalUrl: url });
            }
            return makeResponse(config, { headers: {}, finalUrl: url });
        }

        if (method !== 'GET') {
            throw new Error(`Unexpected mocked method: ${method}`);
        }

        requestAttempts.set(url, (requestAttempts.get(url) || 0) + 1);

        if (url.endsWith('/skill.md')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/plain; charset=utf-8' },
                data: '# Skill Title\n\nThis is a markdown test document.',
                finalUrl: url
            });
        }

        if (url.endsWith('/page')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `
                <html>
                  <head><title>Skill Page</title></head>
                  <body>
                    <main>
                      <h1>Skill Page</h1>
                      <p>${'Skill body content '.repeat(12)}</p>
                    </main>
                  </body>
                </html>
                `,
                finalUrl: `${url}?from=test`
            });
        }

        if (url.endsWith('/long.md')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/markdown; charset=utf-8' },
                data: `# Long\n\n${'x'.repeat(6000)}`,
                finalUrl: url
            });
        }

        if (url.endsWith('/too-large.md')) {
            throw new Error('GET should not be called when HEAD indicates oversized response');
        }

        if (url.endsWith('/spa')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `
                <html>
                  <head>
                    <title>SPA Site</title>
                    <meta name="description" content="Rendered by JS runtime">
                  </head>
                  <body><div id="root"></div></body>
                </html>
                `,
                finalUrl: url
            });
        }

        if (url.endsWith('/browser-spa')) {
            return makeResponse(config, {
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `
                <html>
                  <head>
                    <title>Browser SPA</title>
                    <meta name="description" content="JS bootstrap shell">
                  </head>
                  <body><div id="app"></div></body>
                </html>
                `,
                finalUrl: url
            });
        }

        if (url.endsWith('/zhihu-challenge')) {
            return makeResponse(config, {
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `
                <html>
                  <head><title>你似乎来到了没有知识存在的荒原 - 知乎</title></head>
                  <body>
                    <div>你似乎来到了没有知识存在的荒原</div>
                    <a href="/">去往首页</a>
                  </body>
                </html>
                `,
                finalUrl: url
            });
        }

        if (url.endsWith('/blocked-browser-spa')) {
            return makeResponse(config, {
                status: 403,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: '',
                finalUrl: url
            });
        }

        throw new Error(`Unexpected mocked URL: ${url}`);
    });
}

function restoreMocks(): void {
    __setAxiosRequestForTests();
    __setBrowserHtmlFetcherForTests();
    __setBrowserCookieHeaderForTests();
    __setReadabilityParserForTests();
}

beforeEach(() => {
    originalInsecureTls = config.fetchWebAllowInsecureTls;
    config.fetchWebAllowInsecureTls = false;
    installAxiosMock();
    __setDnsLookupForTests(async (hostname) => {
        if (hostname === 'example.com') {
            return [{ address: '93.184.216.34' }];
        }
        throw new Error(`unexpected hostname: ${hostname}`);
    });
    __setBrowserCookieHeaderForTests(async () => undefined);
    __setBrowserHtmlFetcherForTests();
    __setReadabilityParserForTests();
});

afterEach(() => {
    restoreMocks();
    __setDnsLookupForTests();
    config.fetchWebAllowInsecureTls = originalInsecureTls;
});

describe('fetchWebContent', () => {
    it('parses markdown content by .md URL', async () => {
        const result = await fetchWebContent('https://example.com/skill.md', 5000);
        expect(result.title).toBe('');
        expect(result.content).toContain('Skill Title');
        expect(result.truncated).toBe(false);
    });

    it('extracts text and title from an HTML page', async () => {
        const result = await fetchWebContent('https://example.com/page', 5000);
        expect(result.title).toBe('Skill Page');
        expect(result.retrievalMethod).toBe('request');
        expect(result.finalUrl.endsWith('/page?from=test')).toBe(true);
        expect(result.content).toContain('Skill body content');
        const firstConfig = (requestConfigs.get('https://example.com/page') || [])[0]?.options;
        expect(firstConfig?.proxy).toBe(false);
        expect(firstConfig?.httpsAgent).toBeTruthy();
    });

    it('truncates long content when maxChars is small', async () => {
        const result = await fetchWebContent('https://example.com/long.md', 1200);
        expect(result.truncated).toBe(true);
        expect(result.content).toContain('[truncated; continue with startIndex=');
    });

    it('returns the raw response body when raw is set', async () => {
        const result = await fetchWebContent('https://example.com/page', 5000, { raw: true });
        expect(result.raw).toBeDefined();
        expect(result.content).toContain('<html>');
        expect(result.content).toContain('Skill body content');
        expect(result.title).toBe('');
        expect(result.totalLength).toBe(result.content.length);
    });

    it('pages through long content with startIndex', async () => {
        const page1 = await fetchWebContent('https://example.com/long.md', 1500);
        expect(page1.truncated).toBe(true);
        expect(page1.hasMore).toBe(true);
        expect(typeof page1.nextStartIndex).toBe('number');
        expect(page1.nextStartIndex).toBeGreaterThan(0);
        expect(page1.startIndex).toBe(0);

        const page2 = await fetchWebContent('https://example.com/long.md', 1500, { startIndex: page1.nextStartIndex });
        expect(page2.startIndex).toBe(page1.nextStartIndex);
        expect(page2.content.length).toBeGreaterThan(0);
        expect(page2.content).not.toContain('# Long');
        expect(page1.content + page2.content).toContain('# Long');
    });

    it('supports raw + startIndex combination', async () => {
        const raw1 = await fetchWebContent('https://example.com/long.md', 1500, { raw: true });
        expect(raw1.hasMore).toBe(true);
        const raw2 = await fetchWebContent('https://example.com/long.md', 1500, {
            raw: true,
            startIndex: raw1.nextStartIndex
        });
        expect(raw2.content.length).toBeGreaterThan(0);
        expect(raw2.content).not.toContain(raw1.content.slice(0, 50));
    });

    it('falls back to metadata for js-rendered HTML pages', async () => {
        __setBrowserHtmlFetcherForTests(async () => {
            throw new Error('browser fallback disabled for metadata-only test');
        });
        const result = await fetchWebContent('https://example.com/spa', 5000);
        expect(result.title).toBe('SPA Site');
        expect(result.retrievalMethod).toBe('request');
        expect(result.content).toContain('Rendered by JS runtime');
    });

    it('falls back to browser HTML when HTML only contains shell metadata', async () => {
        __setBrowserHtmlFetcherForTests(async () => ({
            html: `<html><head><title>Browser SPA</title></head><body><main>
                <h1>Browser SPA</h1><p>${'Rendered browser content '.repeat(12)}</p>
            </main></body></html>`,
            finalUrl: 'https://example.com/browser-spa?rendered=1',
            title: 'Browser SPA'
        }));

        const result = await fetchWebContent('https://example.com/browser-spa', 5000);
        expect(result.title).toBe('Browser SPA');
        expect(result.retrievalMethod).toBe('browser-html');
        expect(result.finalUrl.endsWith('rendered=1')).toBe(true);
        expect(result.content).toContain('Rendered browser content');
    });

    it('applies readability extraction and preserves links', async () => {
        __setReadabilityParserForTests(async () => ({
            title: 'Readable Skill Page',
            byline: 'Aasee',
            excerpt: 'Readable excerpt',
            siteName: 'Example Docs',
            content: `<article><h1>Readable Skill Page</h1><p>Readability content with a <a href="/guide">Guide</a>.</p></article>`,
            textContent: 'Readable Skill Page\n\nReadability content with a Guide.'
        }));

        const result = await fetchWebContent('https://example.com/page', 5000, { readability: true, includeLinks: true });
        expect(result.readabilityApplied).toBe(true);
        expect(result.title).toBe('Readable Skill Page');
        expect(result.content).toContain('Readability content with a Guide.');
        expect(result.links?.[0]?.href).toBe('https://example.com/guide');
        expect(result.byline).toBe('Aasee');
        expect(result.excerpt).toBe('Readable excerpt');
        expect(result.siteName).toBe('Example Docs');
    });

    it('falls back to the existing extractor when readability returns null', async () => {
        __setReadabilityParserForTests(async () => null);

        const result = await fetchWebContent('https://example.com/page', 5000, { readability: true, includeLinks: true });
        expect(result.readabilityApplied).toBe(false);
        expect(result.title).toBe('Skill Page');
        expect(result.content).toContain('Skill body content');
        expect(result.links).toBeUndefined();
    });

    it('falls back to browser HTML after a cookie-assisted retry still fails', async () => {
        __setBrowserCookieHeaderForTests(async () => 'mock-browser-cookie=1');
        __setBrowserHtmlFetcherForTests(async () => ({
            html: `<html><head><title>Blocked Browser SPA</title></head><body><main>
                <h1>Blocked Browser SPA</h1><p>${'Recovered after blocked request '.repeat(12)}</p>
            </main></body></html>`,
            finalUrl: 'https://example.com/blocked-browser-spa?rendered=1',
            title: 'Blocked Browser SPA'
        }));

        const result = await fetchWebContent('https://example.com/blocked-browser-spa', 5000);
        expect(result.retrievalMethod).toBe('browser-html');
        expect(requestAttempts.get('https://example.com/blocked-browser-spa') || 0).toBeGreaterThanOrEqual(1);
        expect(result.content).toContain('Recovered after blocked request');
    });

    it('intercepts anti-bot challenge pages with bot_challenge / ERR_BOT_CHALLENGE', async () => {
        __setBrowserHtmlFetcherForTests(async () => {
            throw new Error('Browser challenge timeout');
        });

        let caught: any;
        try {
            await fetchWebContent('https://example.com/zhihu-challenge', 5000);
        } catch (error) {
            caught = error;
        }
        const code = caught?.code;
        const rawCode = caught?.details?.rawCode;
        expect(code === 'bot_challenge' || code === 'ERR_BOT_CHALLENGE').toBe(true);
        expect(rawCode === 'ERR_BOT_CHALLENGE' || code === 'ERR_BOT_CHALLENGE').toBe(true);
    });

    it('rejects non-http protocols', async () => {
        await expect(fetchWebContent('file:///tmp/skill.md', 5000)).rejects.toThrow();
    });

    it('rejects private/local network targets', async () => {
        await expect(fetchWebContent('http://127.0.0.1/private', 5000)).rejects.toThrow();
    });

    it('rejects oversized responses by content-length', async () => {
        await expect(fetchWebContent('https://example.com/too-large.md', 5000)).rejects.toThrow();
    });
});
