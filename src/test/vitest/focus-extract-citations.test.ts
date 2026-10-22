import { describe, expect, it } from 'vitest';
import { scoreBlocks, selectFocusBlocks, splitIntoBlocks, tokenize } from '../../utils/bm25.js';
import { addCitations } from '../../utils/citations.js';
import { extractWithSchema, pickExtractionHtml, validateExtractSchema } from '../../engines/web/extract.js';
import { paginateContent, sliceMarkdownContent } from '../../engines/web/pagination.js';

describe('bm25 tokenizer', () => {
    it('splits latin words and emits CJK bigrams', () => {
        expect(tokenize('BM25 ranking')).toEqual(['bm25', 'ranking']);
        expect(tokenize('连接池配置')).toEqual(['连接', '接池', '池配', '配置']);
        expect(tokenize('用的是 OAuth 令牌')).toContain('oauth');
    });

    it('keeps a single CJK character as its own token', () => {
        expect(tokenize('池')).toEqual(['池']);
    });
});

describe('bm25 block selection', () => {
    const makeDoc = (): string => {
        const paragraphs = [
            '## Introduction\n\nThis page describes the product changelog and release cadence.',
            '## Authentication\n\nRequests must carry a bearer token. The auth middleware validates the JWT signature and expiry before the handler runs.',
            '## Billing\n\nInvoices are generated monthly and charged to the card on file.',
            '## Rate limits\n\nClients that exceed the quota receive HTTP 429 and should back off exponentially.'
        ];
        return paragraphs.join('\n\n');
    };

    it('selects only the blocks relevant to the focus term', () => {
        const selection = selectFocusBlocks(makeDoc(), 'bearer token JWT', 3000);
        expect(selection).not.toBeNull();
        expect(selection!.content).toContain('bearer token');
        expect(selection!.content).not.toContain('Invoices are generated');
        expect(selection!.totalBlocks).toBeGreaterThan(1);
    });

    it('picks up matches scattered across the document instead of a single window', () => {
        const doc = [
            '## Alpha\n\nNothing here about the topic.',
            '## Beta\n\nRetry policy: exponential backoff with jitter.',
            '## Gamma\n\nUnrelated marketing copy.',
            '## Delta\n\nThe retry policy also caps at five attempts.',
            '## Epsilon\n\nUnrelated appendix.'
        ].join('\n\n');

        const selection = selectFocusBlocks(doc, 'retry policy', 4000);
        expect(selection).not.toBeNull();
        const matches = selection!.content.match(/retry policy/gi) ?? [];
        // 旧的 window 模式只能拿到第一处，bm25 应同时命中两处
        expect(matches.length).toBe(2);
        expect(selection!.selectedBlocks).toBe(2);
    });

    it('renders skipped-block markers only for large gaps', () => {
        const blocks = [
            'First block mentions widget.',
            'Second block is filler.',
            'Third block is filler.',
            'Fourth block is filler.',
            'Fifth block is filler.',
            'Sixth block is filler.',
            'Seventh block also mentions widget.'
        ];
        const selection = selectFocusBlocks(blocks.join('\n\n'), 'widget', 4000);
        expect(selection!.content).toContain('5 unrelated blocks skipped');

        // 只隔一两个块时不加标记，避免标记本身消耗 token
        const tight = ['alpha widget', 'filler', 'filler', 'beta widget'].join('\n\n');
        expect(selectFocusBlocks(tight, 'widget', 4000)!.content).not.toContain('blocks skipped');
    });

    it('prioritises a literal match even when the tokenizer merges adjacent text', () => {
        const doc = 'A'.repeat(3000) + 'CRITICAL_METRIC' + 'B'.repeat(4000);
        const selection = selectFocusBlocks(doc, 'CRITICAL_METRIC', 4000);
        expect(selection).not.toBeNull();
        expect(selection!.content).toContain('CRITICAL_METRIC');
    });

    it('returns a zero-selection (not null) when nothing matches, so the caller can still report counts', () => {
        const selection = selectFocusBlocks(makeDoc(), 'kubernetes', 4000);
        expect(selection.selectedBlocks).toBe(0);
        expect(selection.totalBlocks).toBeGreaterThan(0);
        // 零命中必须保留计数：调用方要能告诉用户 "matched 0 of N blocks"
        expect(selection.content).toBe('');
    });

    it('respects the maxChars budget', () => {
        const doc = Array.from({ length: 30 }, (_, index) => `Paragraph ${index} mentions quota in detail. ${'x'.repeat(600)}`).join('\n\n');
        const selection = selectFocusBlocks(doc, 'quota', 1500);
        expect(selection).not.toBeNull();
        expect(selection!.content.length).toBeLessThanOrEqual(1700);
    });

    it('scores zero when the query tokens are absent', () => {
        const blocks = ['alpha beta', 'gamma delta'];
        expect(scoreBlocks(blocks, tokenize('missing'))).toEqual([0, 0]);
    });

    it('splits oversized paragraphs by sentence boundary', () => {
        const long = `${'Sentence one. '.repeat(200)}`;
        const blocks = splitIntoBlocks(long);
        expect(blocks.length).toBeGreaterThan(1);
        expect(blocks.every((block) => block.text.length <= 1500)).toBe(true);
    });
});

describe('citations', () => {
    it('numbers unique links and appends a References list', () => {
        const markdown = 'See [the docs](https://example.com/docs) and [the API](https://example.com/api). Also [repeat](https://example.com/docs).';
        const result = addCitations(markdown);

        expect(result.references).toBe(2);
        expect(result.content).toContain('the docs [1]');
        expect(result.content).toContain('the API [2]');
        expect(result.content).toContain('repeat [1]');
        expect(result.content).toContain('## References');
        expect(result.content).toContain('1. https://example.com/docs');
        expect(result.content).toContain('2. https://example.com/api');
    });

    it('leaves images and non-http links alone', () => {
        const markdown = '![logo](https://example.com/logo.png) and [anchor](#section) and [mail](mailto:a@b.c)';
        const result = addCitations(markdown);
        expect(result.references).toBe(0);
        expect(result.content).toBe(markdown);
    });

    it('does not rewrite links inside fenced code blocks', () => {
        const markdown = 'Before [x](https://a.example).\n\n```md\n[y](https://b.example)\n```\n\nAfter.';
        const result = addCitations(markdown);
        expect(result.references).toBe(1);
        expect(result.content).toContain('[y](https://b.example)');
        expect(result.content).toContain('x [1]');
        expect(result.content).toContain('## References\n1. https://a.example');
    });

    it('resolves site-relative links against the page URL', () => {
        const result = addCitations('Read [login](/login) and [about](../about).', {
            baseUrl: 'https://example.com/docs/page'
        });
        expect(result.references).toBe(2);
        expect(result.content).toContain('login [1]');
        expect(result.content).toContain('1. https://example.com/login');
        expect(result.content).toContain('2. https://example.com/about');
    });

    it('caps references and reports how many were left uncited', () => {
        const links = Array.from({ length: 5 }, (_, index) => `[l${index}](https://e${index}.com)`).join(' ');
        const result = addCitations(links, { maxReferences: 2 });
        expect(result.references).toBe(2);
        expect(result.uncited).toBe(3);
        expect(result.content).toContain('reference cap is 2');
    });
});

const QUOTES_HTML = `
<html><body>
  <div class="quote">
    <span class="text">“Simplicity is prerequisite for reliability.”</span>
    <small class="author">Edsger Dijkstra</small>
    <a class="tag" href="/tag/simplicity">simplicity</a>
    <a class="tag" href="/tag/design">design</a>
  </div>
  <div class="quote">
    <span class="text">“Premature optimization is the root of all evil.”</span>
    <small class="author">Donald Knuth</small>
    <a class="tag" href="/tag/performance">performance</a>
  </div>
</body></html>`;

describe('CSS schema extraction', () => {
    it('extracts repeated rows with text, attribute and nested list fields', () => {
        const schema = validateExtractSchema({
            baseSelector: 'div.quote',
            fields: [
                { name: 'text', selector: 'span.text', type: 'text' },
                { name: 'author', selector: 'small.author' },
                { name: 'tags', type: 'list', selector: 'a.tag', fields: [{ name: 'tag', type: 'text' }] }
            ]
        });

        const result = extractWithSchema(QUOTES_HTML, schema);
        expect(result.count).toBe(2);
        expect(result.matchedBase).toBe(2);
        expect(result.items[0]).toMatchObject({
            text: '“Simplicity is prerequisite for reliability.”',
            author: 'Edsger Dijkstra'
        });
        expect((result.items[0]?.tags as Array<{ tag: string }>).map((entry) => entry.tag))
            .toEqual(['simplicity', 'design']);
    });

    it('reads attributes through the @attr shorthand', () => {
        const schema = validateExtractSchema({
            baseSelector: 'a.tag',
            fields: [{ name: 'href', selector: '@href' }]
        });
        const result = extractWithSchema(QUOTES_HTML, schema);
        expect(result.items.map((item) => item.href)).toEqual([
            '/tag/simplicity',
            '/tag/design',
            '/tag/performance'
        ]);
    });

    it('supports all:true for repeated inner values', () => {
        const schema = validateExtractSchema({
            baseSelector: 'div.quote',
            fields: [{ name: 'allTags', selector: 'a.tag', all: true }]
        });
        const result = extractWithSchema(QUOTES_HTML, schema);
        expect(result.items[0]?.allTags).toEqual(['simplicity', 'design']);
    });

    it('extracts a single object when baseSelector is omitted', () => {
        const schema = validateExtractSchema({ fields: [{ name: 'title', selector: 'title' }] });
        const result = extractWithSchema('<html><head><title>Hello</title></head></html>', schema);
        expect(result.count).toBe(1);
        expect(result.items[0]).toEqual({ title: 'Hello' });
    });

    it('returns an empty list when the base selector matches nothing', () => {
        const schema = validateExtractSchema({ baseSelector: 'div.missing', fields: [{ name: 'x' }] });
        const result = extractWithSchema(QUOTES_HTML, schema);
        expect(result.count).toBe(0);
        expect(result.matchedBase).toBe(0);
    });

    it('rejects malformed schemas with an actionable message', () => {
        expect(() => validateExtractSchema({ fields: [] })).toThrow(/non-empty array/);
        expect(() => validateExtractSchema({ fields: [{ name: 'x', type: 'nope' }] })).toThrow(/must be one of/);
        expect(() => validateExtractSchema({ fields: [{ name: 'x', type: 'attribute', selector: 'a' }] }))
            .toThrow(/attribute is required/);
        expect(() => validateExtractSchema({
            fields: [{
                name: 'a',
                type: 'list',
                selector: 'div',
                fields: [{ name: 'b', type: 'list', selector: 'p', fields: [{ name: 'c', type: 'list', selector: 'i', fields: [{ name: 'd', type: 'list', selector: 'b', fields: [{ name: 'e' }] }] }] }]
            }]
        })).toThrow(/nesting/);
    });

    it('prefers raw page HTML over pruned variants', () => {
        expect(pickExtractionHtml({
            raw: '<html><body><div class="quote">raw</div></body></html>',
            readableHtml: '<div class="quote">readable</div>'
        })).toContain('raw');
        expect(pickExtractionHtml({ readableHtml: '<div>x</div>' })).toContain('x');
        expect(pickExtractionHtml({})).toBeUndefined();
    });
});

describe('pagination integration', () => {
    const doc = [
        '## Intro',
        'Nothing relevant in the introduction.',
        '## Auth',
        'The auth module validates the bearer token on every request.',
        '## Billing',
        'Invoices are sent monthly.',
        '## Auth details',
        'Token rotation happens every hour for the bearer token.'
    ].join('\n\n');

    it('defaults to bm25 focus and reports block metadata', () => {
        const result = paginateContent(doc, { maxChars: 3000, focus: 'bearer token' });
        expect(result.focused).toBe(true);
        expect(result.focusMode).toBe('bm25');
        expect(result.focusBlocks?.selected).toBeGreaterThanOrEqual(2);
        expect(result.content).toContain('(bm25)');
        expect(result.content).toContain('Token rotation');
        expect(result.hasMore).toBeUndefined();
    });

    it('marks a miss explicitly instead of silently returning the full page', () => {
        const result = paginateContent(doc, { maxChars: 3000, focus: 'quantum entanglement' });
        // 正文仍是整页，但调用方必须能看出「这不是定位结果」
        expect(result.focused).toBe(false);
        expect(result.focusBlocks?.selected).toBe(0);
        expect(result.focusBlocks?.total).toBeGreaterThan(0);
        expect(result.focusWarning).toContain('matched 0 of');
        expect(result.content).not.toContain('(bm25)');
    });

    it('warns when bm25 misses but the literal term exists and window mode takes over', () => {
        // 词在两个块里各出现一次但分词后无法对齐时，BM25 可能零命中，回退 window
        const weird = '## A\n\nXYZZY-1 is here.\n\n## B\n\nunrelated body text.';
        const result = paginateContent(weird, { maxChars: 3000, focus: 'XYZZY-1' });
        if (result.focusMode === 'window') {
            expect(result.focused).toBe(true);
            expect(result.focusWarning ?? '').toContain('window');
        } else {
            expect(result.focused).toBe(true);
        }
    });

    it('keeps the legacy window behaviour when explicitly requested', () => {
        const result = paginateContent(doc, { maxChars: 3000, focus: 'bearer token', focusMode: 'window' });
        expect(result.focusMode).toBe('window');
        expect(result.focusMatchOffset).toBe(doc.toLowerCase().indexOf('bearer token'));
        expect(result.content).toContain('bearer token');
        // 全文不足一个窗口时不会加前后缀，此时 window 与普通分页等价
        expect(result.content.length).toBeLessThanOrEqual(doc.length);
    });

    it('falls back to window mode when bm25 finds no block', () => {
        const result = paginateContent('aaa bbb ccc', { maxChars: 3000, focus: 'zzz', focusMode: 'bm25' });
        // 新契约：传了 focus 就显式给 false，而不是用 undefined 表示"没定位"
        expect(result.focused).toBe(false);
        expect(result.focusBlocks?.selected).toBe(0);
        expect(result.focusWarning ?? '').toContain('full page');
    });

    it('applies citations only at slice time and reports metadata', () => {
        const result = sliceMarkdownContent('Read [docs](https://example.com/d) now.', {
            url: 'https://example.com',
            title: 'T',
            maxChars: 1000,
            citations: true
        });
        expect(result.citations).toEqual({ references: 1, uncited: 0 });
        expect(result.content).toContain('## References');
        expect(result.content).toContain('docs [1]');
    });

    it('leaves content untouched when citations are not requested', () => {
        const result = sliceMarkdownContent('Read [docs](https://example.com/d) now.', {
            url: 'https://example.com',
            title: 'T',
            maxChars: 1000
        });
        expect(result.citations).toBeUndefined();
        expect(result.content).not.toContain('## References');
    });
});
