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
