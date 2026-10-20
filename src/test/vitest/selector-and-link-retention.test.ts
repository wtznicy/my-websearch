import { describe, expect, it } from 'vitest';
import { scopeHtmlToSelector } from '../../utils/htmlScope.js';
import { applyLinkRetention } from '../../utils/linkRetention.js';
import { transformMarkdownLinks } from '../../utils/markdownLinks.js';
import { sliceMarkdownContent } from '../../engines/web/pagination.js';
import { createWebFetchService } from '../../core/fetch/fetchServices.js';
import type { FetchWebContentResult } from '../../engines/web/fetchWebContent.js';

const MAIN_BODY = 'This is the real article body explaining how the thing works. '.repeat(8);

const SCOPED_HTML = `
<html>
  <head><title>Scoped Doc</title></head>
  <body>
    <nav class="site-nav">Home | Pricing | Login | Sign Up</nav>
    <div id="main">
      <h2>Real Article</h2>
      <p>${MAIN_BODY}</p>
      <pre><code class="language-ts">export const answer = 42;</code></pre>
    </div>
    <div id="sidebar">
      <h3>Noise Heading</h3>
      <p>Sidebar noise that must not appear in scoped output.</p>
    </div>
    <footer>Copyright 2026</footer>
  </body>
</html>
`;

/** 复用项目既有的 axios/DNS 注入点，避免测试依赖真实网络。 */
async function withMockedResponse(
    html: string,
    contentType: string,
    run: () => Promise<void>
): Promise<void> {
    const { __setAxiosRequestForTests } = await import('../../utils/httpRequest.js');
    const { __setDnsLookupForTests } = await import('../../utils/urlSafety.js');

    __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    __setAxiosRequestForTests(async (cfg: unknown) => ({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': contentType },
        data: html,
        config: cfg,
        request: { res: { responseUrl: (cfg as { url?: string }).url } }
    }) as unknown as never);

    try {
        await run();
    } finally {
        __setAxiosRequestForTests();
        __setDnsLookupForTests();
    }
}

describe('scopeHtmlToSelector', () => {
    it('returns the matched subtree as outerHTML', () => {
        const result = scopeHtmlToSelector(SCOPED_HTML, '#main');
        expect(result.matched).toBe(1);
        expect(result.html).toContain('Real Article');
        expect(result.html).toContain('export const answer = 42;');
        expect(result.html).not.toContain('Sidebar noise');
        expect(result.html).not.toContain('Copyright 2026');
    });

    it('concatenates every matched node so list selectors keep all items', () => {
        const result = scopeHtmlToSelector('<div class="x">first</div><p>gap</p><div class="x">second</div>', '.x');
        expect(result.matched).toBe(2);
        expect(result.html).toContain('first');
        expect(result.html).toContain('second');
        expect(result.html).not.toContain('gap');
    });

    it('fails loudly with actionable candidates instead of falling back to the whole page', () => {
        let error: unknown;
        try {
            scopeHtmlToSelector(SCOPED_HTML, '#does-not-exist');
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeDefined();
        const appError = error as { code?: string; details?: { candidates?: string[] } };
        expect(appError.code).toBe('selector_not_found');
        // 页面里有 <nav> 和 <div id="main">，候选里应当能提示到可用的选择器
        expect(appError.details?.candidates).toContain('#main');
    });

    it('rejects malformed selectors as invalid_arguments', () => {
        expect(() => scopeHtmlToSelector(SCOPED_HTML, 'div[')).toThrowError(/Invalid CSS selector/);
    });
});

describe('markdownLinks', () => {
    it('leaves code fences untouched', () => {
        const input = 'before [a](https://a.example)\n\n```md\n[b](https://b.example)\n```\n\nafter';
        const output = transformMarkdownLinks(input, (link) => (link.isImage ? '[img]' : 'DROP'));
        expect(output).toContain('DROP');
        expect(output).toContain('[b](https://b.example)');
    });

    it('flags images so callers can keep them verbatim', () => {
        const seen: boolean[] = [];
        transformMarkdownLinks('![logo](https://e.example/l.png) and [doc](https://e.example/d)', (link) => {
            seen.push(link.isImage);
            return 'X';
        });
        expect(seen).toEqual([true, false]);
    });
});

describe('applyLinkRetention', () => {
    it("'text' keeps anchor text and strips URLs", () => {
        const result = applyLinkRetention('Read [the docs](https://e.example/docs) now.', 'text');
        expect(result.content).toBe('Read the docs now.');
        expect(result.links).toBe(1);
    });

    it("'none' removes the whole link construct", () => {
        const result = applyLinkRetention('Read [the docs](https://e.example/docs) now.', 'none');
        expect(result.content).toBe('Read  now.');
        expect(result.links).toBe(1);
    });

    it("'all' is a no-op", () => {
        const input = 'Read [the docs](https://e.example/docs) now.';
        expect(applyLinkRetention(input, 'all')).toEqual({ content: input, links: 0 });
    });

    it('does not touch images or fenced code blocks', () => {
        const input = '![logo](https://e.example/l.png)\n\n```md\n[doc](https://e.example/d)\n```';
        const result = applyLinkRetention(input, 'text');
        expect(result.content).toContain('![logo](https://e.example/l.png)');
        expect(result.content).toContain('[doc](https://e.example/d)');
        expect(result.links).toBe(0);
    });
});

describe('selector: end-to-end fetchWebContent', () => {
    it('returns only the scoped subtree and echoes the selector', async () => {
        const { fetchWebContent } = await import('../../engines/web/fetchWebContent.js');

        await withMockedResponse(SCOPED_HTML, 'text/html; charset=utf-8', async () => {
            const result = await fetchWebContent('https://example.com/doc', 10000, {
                format: 'markdown',
                selector: '#main'
            });

            expect(result.scoped).toEqual({ selector: '#main', matched: 1 });
            expect(result.content).toContain('## Real Article');
            expect(result.content).toContain('export const answer = 42;');
            expect(result.content).not.toContain('Sidebar noise');
            expect(result.content).not.toContain('Home | Pricing');
            expect(result.content).not.toContain('Copyright 2026');
            // 标题仍然来自整页 <title>，不会因为收窄而丢失
            expect(result.title).toBe('Scoped Doc');
        });
    });

    it('throws selector_not_found instead of silently returning the full page', async () => {
        const { fetchWebContent } = await import('../../engines/web/fetchWebContent.js');

        await withMockedResponse(SCOPED_HTML, 'text/html; charset=utf-8', async () => {
            await expect(fetchWebContent('https://example.com/doc', 10000, {
                format: 'markdown',
                selector: '#nope'
            })).rejects.toMatchObject({ code: 'selector_not_found' });
        });
    });

    it('rejects selector on a non-HTML response', async () => {
        const { fetchWebContent } = await import('../../engines/web/fetchWebContent.js');

        await withMockedResponse('%PDF-1.4 fake', 'application/pdf', async () => {
            await expect(fetchWebContent('https://example.com/paper.pdf', 10000, {
                selector: '#main'
            })).rejects.toMatchObject({ code: 'extraction_failed' });
        });
    });
});

describe('option combination validation', () => {
    const noFetchService = () => createWebFetchService(async () => {
        throw new Error('the fetcher must not be called when options are invalid');
    });

    it('rejects selector combined with extract', async () => {
        await expect(noFetchService().execute({
            url: 'https://example.com/a',
            maxChars: 1000,
            selector: '#main',
            extract: { fields: [{ name: 'title', selector: 'h1' }] }
        })).rejects.toMatchObject({ code: 'invalid_arguments' });
    });

    it('rejects selector combined with raw', async () => {
        await expect(noFetchService().execute({
            url: 'https://example.com/a',
            maxChars: 1000,
            selector: '#main',
            raw: true
        })).rejects.toMatchObject({ code: 'invalid_arguments' });
    });

    it('rejects citations combined with URL-stripping link retention', async () => {
        await expect(noFetchService().execute({
            url: 'https://example.com/a',
            maxChars: 1000,
            citations: true,
            retainLinks: 'text'
        })).rejects.toMatchObject({ code: 'invalid_arguments' });
    });

    it('forwards selector to the fetcher', async () => {
        let seenSelector: string | undefined;
        const service = createWebFetchService(async (_url, _maxChars, options) => {
            seenSelector = options?.selector;
            const body = `${'x'.repeat(600)}`;
            return {
                url: 'https://example.com/a',
                finalUrl: 'https://example.com/a',
                contentType: 'text/markdown',
                title: 'T',
                retrievalMethod: 'request',
                truncated: false,
                content: body,
                totalLength: body.length,
                startIndex: 0,
                scoped: { selector: '#main', matched: 1 }
            } satisfies FetchWebContentResult;
        });

        const result = await service.execute({
            url: 'https://example.com/a',
            maxChars: 500,
            selector: '#main'
        });

        expect(seenSelector).toBe('#main');
        expect(result.content).toContain('x');
        expect(result.scoped).toEqual({ selector: '#main', matched: 1 });
    });

    it('bypasses the page cache for selector requests (cache holds unscoped markdown)', async () => {
        let calls = 0;
        const service = createWebFetchService(async () => {
            calls += 1;
            const body = `${'y'.repeat(600)}`;
            return {
                url: 'https://example.com/a',
                finalUrl: 'https://example.com/a',
                contentType: 'text/markdown',
                title: 'Example',
                retrievalMethod: 'request',
                truncated: false,
                content: body,
                totalLength: body.length,
                startIndex: 0
            } satisfies FetchWebContentResult;
        });

        const url = `https://example.com/scoped-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        await service.execute({ url, maxChars: 500 });
        expect(calls).toBe(1);

        // 先证明缓存确实在工作
        const cached = await service.execute({ url, maxChars: 500 });
        expect(cached.cached).toBe(true);
        expect(calls).toBe(1);

        // selector 会改变提取结果，必须重新抓取
        const scoped = await service.execute({ url, maxChars: 500, selector: '#main' });
        expect(scoped.cached).toBe(false);
        expect(calls).toBe(2);
    });
});

describe('retainLinks at slice time', () => {
    const markdown = `Intro [one](https://e.example/1) ${'body '.repeat(40)} Outro [two](https://e.example/2)`;

    it('strips URLs but keeps pagination offsets identical', () => {
        const all = sliceMarkdownContent(markdown, { url: 'https://e.example', title: 'T', maxChars: 5000 });
        const stripped = sliceMarkdownContent(markdown, {
            url: 'https://e.example',
            title: 'T',
            maxChars: 5000,
            retainLinks: 'text'
        });

        expect(all.content).toContain('https://e.example/1');
        expect(stripped.content).not.toContain('https://e.example/1');
        expect(stripped.content).toContain('one');
        expect(stripped.retainLinks?.mode).toBe('text');
        expect(stripped.retainLinks?.links).toBe(2);
        // 分页在「未裁剪」文本上计算，因此切换 retainLinks 不会让 startIndex 语义漂移
        expect(stripped.totalLength).toBe(all.totalLength);
    });

    it('does not emit retainLinks metadata for the default mode', () => {
        const result = sliceMarkdownContent(markdown, { url: 'https://e.example', title: 'T', maxChars: 5000 });
        expect(result.retainLinks).toBeUndefined();
    });
});
