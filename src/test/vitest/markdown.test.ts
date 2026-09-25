import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../../utils/markdown.js';

describe('htmlToMarkdown', () => {
    it('should preserve fenced code blocks with language', () => {
        const html = '<p>example:</p><pre><code class="language-typescript">const x: number = 1;</code></pre>';
        const markdown = htmlToMarkdown(html);
        expect(markdown).toContain('```typescript');
        expect(markdown).toContain('const x: number = 1;');
    });

    it('should convert GFM tables', () => {
        const html = `<table><thead><tr><th>Name</th><th>Value</th></tr></thead>
<tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>`;
        const markdown = htmlToMarkdown(html);
        expect(markdown).toContain('| Name | Value |');
        expect(markdown).toContain('| a | 1 |');
    });

    it('should convert headings and lists', () => {
        const markdown = htmlToMarkdown('<h2>Title</h2><ul><li>one</li><li>two</li></ul>');
        expect(markdown).toContain('## Title');
        // turndown 列表标记为 "-   "（连字符 + 多空格），用宽松匹配
        expect(markdown).toMatch(/- +one/);
        expect(markdown).toMatch(/- +two/);
    });

    it('should return empty string for empty input', () => {
        expect(htmlToMarkdown('')).toBe('');
        expect(htmlToMarkdown('   ')).toBe('');
    });
});

/**
 * 报告 P0-2 的复现用例：旧判据 `pre.firstChild?.nodeName === 'CODE'` 对格式化后的 HTML 失效
 * （首子节点是换行/缩进空白文本），导致语言丢失、甚至退化成行内代码。
 */
describe('htmlToMarkdown 代码块围栏（真实页面结构）', () => {
    it('code 前有换行空白时仍应产出带语言的围栏（旧实现会退化成行内代码）', () => {
        const markdown = htmlToMarkdown('<pre>\n  <code class="language-python">print(1)</code></pre>');
        expect(markdown).toContain('```python');
        expect(markdown).toContain('print(1)');
        expect(markdown).not.toContain('`print(1)`');
    });

    it('语言标识应支持 pre[lang] / pre[data-lang] / code[data-lang]', () => {
        expect(htmlToMarkdown('<pre lang="ts">const a = 1</pre>')).toContain('```ts');
        expect(htmlToMarkdown('<pre data-lang="go">x := 1</pre>')).toContain('```go');
        expect(htmlToMarkdown('<pre><code data-lang="rust">let a = 1;</code></pre>')).toContain('```rust');
    });

    it('hljs 这类无语言信息的高亮类名不应被当成语言', () => {
        const noLang = htmlToMarkdown('<pre><code class="hljs">x = 1</code></pre>');
        expect(noLang).toContain('```\nx = 1\n```');
        const withLang = htmlToMarkdown('<pre><code class="hljs language-ts">x = 1</code></pre>');
        expect(withLang).toContain('```ts');
    });

    it('SyntaxHighlighter 的 brush 语法应识别出语言', () => {
        const markdown = htmlToMarkdown('<pre class="brush: js; toolbar: false;">var a = 1;</pre>');
        expect(markdown).toContain('```js');
        expect(markdown).toContain('var a = 1;');
    });

    it('代码内容含三反引号时应用更长的围栏，避免结构破损', () => {
        const markdown = htmlToMarkdown('<pre><code class="language-md">line1\n```\nline3</code></pre>');
        expect(markdown).toContain('````md');
        expect(markdown).toContain('line1\n```\nline3');
    });
});

describe('fetchWebContent noise stripping & format=markdown', () => {
    it('strips nested nav/aside/footer noise inside main/body and converts to markdown without requiring readability=true', async () => {
        const { fetchWebContent } = await import('../../engines/web/fetchWebContent.js');
        const { __setAxiosRequestForTests } = await import('../../utils/httpRequest.js');
        const { __setDnsLookupForTests } = await import('../../utils/urlSafety.js');

        __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
        __setAxiosRequestForTests(async (cfg: any) => ({
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/html; charset=utf-8' },
            data: `
                <html>
                  <head><title>Doc Page</title></head>
                  <body>
                    <main>
                      <nav class="navbar">Home | Pricing | Login | Sign Up</nav>
                      <aside class="sidebar">Sidebar Link 1 | Sidebar Link 2</aside>
                      <h2>Quick Start Guide</h2>
                      <p>${'This is the real technical documentation content explaining configuration. '.repeat(3)}</p>
                      <pre><code class="language-ts">export const answer = 42;</code></pre>
                      <footer>Copyright 2026 All rights reserved</footer>
                    </main>
                  </body>
                </html>
            `,
            config: cfg,
            request: { res: { responseUrl: cfg.url } }
        } as any));

        try {
            const res = await fetchWebContent('https://example.com/docs/guide.html', 10000, {
                format: 'markdown'
            });
            expect(res.content).toContain('## Quick Start Guide');
            expect(res.content).toContain('```ts');
            expect(res.content).toContain('export const answer = 42;');
            expect(res.content).not.toContain('Home | Pricing | Login');
            expect(res.content).not.toContain('Sidebar Link 1');
            expect(res.content).not.toContain('Copyright 2026');
        } finally {
            __setAxiosRequestForTests();
            __setDnsLookupForTests();
        }
    });

    it('keeps the article title when it lives inside <header> (blog/docs 常见结构)', async () => {
        const { fetchWebContent } = await import('../../engines/web/fetchWebContent.js');
        const { __setAxiosRequestForTests } = await import('../../utils/httpRequest.js');
        const { __setDnsLookupForTests } = await import('../../utils/urlSafety.js');

        __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
        // 实测结构（blog.vuejs.org/posts/vue-3-5）：文章标题的 <h1> 在 <article><header> 内，
        // 剥离 header 时若不救回 h1/h2，正文标题会整条消失
        __setAxiosRequestForTests(async (cfg: any) => ({
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/html; charset=utf-8' },
            data: `
                <html>
                  <head><title>Announcing Vue 3.5 | The Vue Point</title></head>
                  <body>
                    <article>
                      <header>
                        <h1>Announcing Vue 3.5</h1>
                        <p>Evan You · 2024-09-03</p>
                      </header>
                      <nav class="breadcrumb">Home › Blog › Vue 3.5</nav>
                      <p>${'Today we are excited to announce the release of Vue 3.5. '.repeat(4)}</p>
                      <footer>© 2024 Vue.js</footer>
                    </article>
                  </body>
                </html>
            `,
            config: cfg,
            request: { res: { responseUrl: cfg.url } }
        } as any));

        try {
            const res = await fetchWebContent('https://blog.example.com/posts/vue-3-5', 10000, {
                format: 'markdown'
            });
            // 标题保留（markdown 模式下是 H1）
            expect(res.content).toContain('Announcing Vue 3.5');
            expect(res.content).toMatch(/^#+\s+Announcing Vue 3\.5/m);
            // 导航/页脚仍然被剥离
            expect(res.content).not.toContain('Home › Blog');
            expect(res.content).not.toContain('© 2024 Vue.js');
        } finally {
            __setAxiosRequestForTests();
            __setDnsLookupForTests();
        }
    });
});

describe('htmlToMarkdown VitePress/Shiki 结构', () => {
    it('语言类在外层容器、且带可见语言标签时，应产出带语言的围栏且不残留标签文本', () => {
        const html = '<div class="language-html vp-adaptive-theme"><span class="lang">html</span>'
            + '<pre class="shiki"><code>&lt;div id="app"&gt;&lt;/div&gt;</code></pre></div>';
        const markdown = htmlToMarkdown(html);

        expect(markdown).toContain('```html');
        expect(markdown).toContain('<div id="app"></div>');
        // 语言标签不应作为普通文本漏进正文
        expect(markdown).not.toMatch(/^\s*html\s*$/m);
    });

    it('外层有语言类但无标签元素时同样识别', () => {
        const html = '<div class="language-ts"><pre><code>const a = 1;</code></pre></div>';
        expect(htmlToMarkdown(html)).toContain('```ts');
    });
});

describe('htmlToMarkdown 代码组 Tabs 标签', () => {
    it('VitePress 代码组的 Tab 标签不应连成噪声文本', () => {
        const html = '<div class="vp-code-group"><div class="tabs">'
            + '<input type="radio" checked><label data-title="npm">npm</label>'
            + '<label data-title="pnpm">pnpm</label><label data-title="yarn">yarn</label></div>'
            + '<div class="language-sh"><span class="lang">sh</span><pre><code>$ npm create vue@latest</code></pre></div></div>';
        const markdown = htmlToMarkdown(html);

        expect(markdown).toContain('```sh');
        expect(markdown).toContain('$ npm create vue@latest');
        expect(markdown).not.toContain('npmpnpmyarn');
    });
});
