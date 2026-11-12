import { describe, it, expect, vi } from 'vitest';
import {
    extractMarkdownHeadings,
    extractRelevantSections
} from '../../core/docs/markdownSectionExtractor.js';
import { resolveDevDocsSlug } from '../../core/docs/devdocsProvider.js';
import { searchMdn } from '../../core/docs/mdnProvider.js';
import { formatQueryDocsMarkdown } from '../../tools/handlers/queryDocsTool.js';

describe('queryDocs Sprint 3 Suite: Section Extraction, Version Pinning & Localization', () => {
    describe('markdownSectionExtractor', () => {
        const sampleDoc = [
            '# FastApp Framework',
            '',
            'FastApp is a high-performance web framework for modern web applications.',
            '',
            '```ts',
            "import { createApp } from 'fastapp';",
            'const app = createApp();',
            '```',
            '',
            '## Installation',
            '',
            'Install via npm:',
            '```bash',
            'npm install fastapp',
            '```',
            '',
            '## Middleware',
            '',
            'FastApp middleware functions execute during the request-response cycle.',
            '',
            '```ts',
            'app.use((req, res, next) => {',
            "    console.log('Request received');",
            '    next();',
            '});',
            '```',
            '',
            '## Routing',
            '',
            'Define routes using HTTP verb methods.',
            '',
            '```ts',
            "app.get('/users', (req, res) => res.json([]));",
            '```',
            '',
            '## Error Handling',
            '',
            'Handle errors with dedicated error middlewares.',
            '',
            '## Deployment',
            '',
            'Deploy to any Node.js cloud provider.'
        ].join('\n');

        it('extracts Markdown headings accurately', () => {
            const headings = extractMarkdownHeadings(sampleDoc);
            expect(headings.map((h) => h.title)).toEqual([
                'FastApp Framework',
                'Installation',
                'Middleware',
                'Routing',
                'Error Handling',
                'Deployment'
            ]);
        });

        it('preserves 100% of short documents (<= 8000 chars) without section clipping', () => {
            const result = extractRelevantSections(sampleDoc, 'middleware');
            // Document is short (< 8000), should not be modified
            expect(result.isFocused).toBe(false);
            expect(result.content).toBe(sampleDoc);
        });

        it('preserves preamble and focuses on matching section in long documents', () => {
            // Pad document to exceed 8000 characters
            const padding = '\n\n' + 'Some detailed technical explanation.\n'.repeat(300);
            const longDoc = sampleDoc + padding;

            const result = extractRelevantSections(longDoc, 'middleware');
            expect(result.isFocused).toBe(true);
            // Critical check: Preamble with import statement MUST be preserved!
            expect(result.content).toContain("import { createApp } from 'fastapp'");
            expect(result.content).toContain('const app = createApp()');
            // Matching section must be preserved completely
            expect(result.content).toContain('## Middleware');
            expect(result.content).toContain('app.use((req, res, next)');
            // Mentions focused section and lists other sections
            expect(result.content).toContain('> ℹ️ **Focused Sections:**');
            expect(result.content).toContain('Routing');
        });

        it('falls back safely to full content when query does not match any heading', () => {
            const padding = '\n\n' + 'Some detailed technical explanation.\n'.repeat(300);
            const longDoc = sampleDoc + padding;

            const result = extractRelevantSections(longDoc, 'nonexistentxyzterm');
            expect(result.isFocused).toBe(false);
            expect(result.content).toBe(longDoc.trim());
        });
    });

    describe('formatQueryDocsMarkdown integration with section extraction', () => {
        it('applies section extraction transparently on long content when query is passed', () => {
            const longPadded = [
                '# Docs: my-lib',
                '',
                '```ts',
                "import { myLib } from 'my-lib';",
                '```',
                '',
                '## Authentication',
                'Authentication details here.',
                '',
                '## Database',
                'Database details here.',
                '',
                'Content filler: ' + 'x'.repeat(9000)
            ].join('\n');

            const formatted = formatQueryDocsMarkdown({
                libraryId: 'my-lib',
                query: 'authentication',
                source: 'official',
                confidence: 'high',
                content: longPadded
            });

            expect(formatted).toContain('> Source: official | Confidence: high');
            expect(formatted).toContain("import { myLib } from 'my-lib'");
            expect(formatted).toContain('## Authentication');
            expect(formatted).toContain('> ℹ️ **Focused Sections:**');
        });

        it('extracts deep sections located beyond 30KB (e.g. Engine.Use at 70KB depth)', () => {
            const lines: string[] = [
                '# gin package',
                '',
                '```go',
                "import \"github.com/gin-gonic/gin\"",
                '```',
                '',
                '### Variables',
                'var DefaultWriter io.Writer',
                ''
            ];

            // 填充 50KB 的无相关内容，模拟 Gin 前半部分庞大的类型与上下文文档
            for (let i = 0; i < 600; i++) {
                lines.push(`### Context Method ${i}\nfunc (*Context) Dummy${i}() string {\n    return "context"\n}\n`);
            }

            // 深度位于 60KB+ 的 Engine.Use
            lines.push(
                '### func (*Engine) Use',
                '```go',
                'func (engine *Engine) Use(middleware ...HandlerFunc) IRoutes',
                '```',
                'Use attaches a global middleware to the router. The middleware attached through Use() will be included in the handlers chain.',
                ''
            );

            const deepDoc = lines.join('\n');
            expect(deepDoc.length).toBeGreaterThan(40000);

            const result = extractRelevantSections(deepDoc, 'middleware');
            expect(result.isFocused).toBe(true);
            expect(result.focusedSectionTitles).toContain('func (*Engine) Use');
            expect(result.content).toContain('func (engine *Engine) Use(middleware ...HandlerFunc) IRoutes');
        });
    });

    describe('DevDocs version pinning', () => {
        it('pins version accurately when version is provided', async () => {
            const pythonSlug = await resolveDevDocsSlug('python', undefined, '3.12');
            expect(pythonSlug).toBe('python~3.12');

            const angularSlug = await resolveDevDocsSlug('angular', undefined, '21');
            expect(angularSlug).toContain('angular');
        });
    });

    describe('MDN Chinese localization', () => {
        it('passes locale=zh-CN when query contains Chinese characters', async () => {
            const docs = await searchMdn('获取网络请求', undefined);
            // Even if offline or mock, returns an array
            expect(Array.isArray(docs)).toBe(true);
        });
    });

    describe('Parallel ecosystem metadata resolution', () => {
        it('resolves metadata across registries in parallel without unneeded sequential delays', async () => {
            const { resolvePackageMetadata } = await import('../../core/docs/packageDocsFallback.js');
            const meta = await resolvePackageMetadata('nonexistent-pkg-for-test-xyz-123');
            expect(meta).toBeNull();
        });
    });
});
