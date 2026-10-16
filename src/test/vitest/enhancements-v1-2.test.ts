import { describe, it, expect } from 'vitest';
import { preprocessSearchQuery, cleanStackTraceNoise } from '../../utils/queryPreprocess.js';
import { rankSearchResults } from '../../core/search/resultRanking.js';
import type { SearchResult } from '../../types.js';

describe('preprocessSearchQuery & cleanStackTraceNoise', () => {
    it('should strip stack traces, file paths, line/col numbers from query', () => {
        const noisy = `TypeError: Cannot read properties of undefined (reading 'map')
    at renderItems (D:\\Desktop\\project\\src\\components\\List.tsx:142:18)
    at 0x7fff5fbff820 2026-03-15T08:30:00Z
    at react-dom.development.js:8492:12`;

        const cleaned = preprocessSearchQuery(noisy);
        expect(cleaned).not.toContain('D:\\Desktop');
        expect(cleaned).not.toContain('142:18');
        expect(cleaned).not.toContain('0x7fff5fbff820');
        expect(cleaned).not.toContain('2026-03-15T08:30:00Z');
        expect(cleaned).toContain('Cannot read properties of undefined');
    });

    it('should leave normal short queries intact', () => {
        const query = 'React useEffect cleanup function';
        expect(preprocessSearchQuery(query)).toBe(query);
    });
});

describe('rankSearchResults Freshness Boost', () => {
    function makeResult(overrides: Partial<SearchResult>): SearchResult {
        return {
            title: 'React 最新特性指南',
            url: 'https://example.com/react',
            description: '讲解 React 最新特性与实践',
            source: 'example.com',
            engine: 'bing',
            ...overrides
        };
    }

    it('should boost recent articles when query contains freshness intent', () => {
        const currentYear = new Date().getFullYear();
        const oldYear = currentYear - 4;
        const newYear = currentYear;

        const oldArticle = makeResult({
            title: `React 教程 (${oldYear})`,
            url: 'https://example.com/old',
            description: '这是很早的教程',
            date: `${oldYear}-05`
        });

        const newArticle = makeResult({
            title: `React 教程 (${newYear})`,
            url: 'https://example.com/new',
            description: '这是最新的教程',
            date: `${newYear}-01`
        });

        // When query explicitly has freshness intent "最新"
        const ranked = rankSearchResults([oldArticle, newArticle], 'React 最新 教程');
        expect(ranked[0].url).toBe('https://example.com/new');
    });
});

describe('generateMarkdownToc', () => {
    it('should extract #, ##, ### headings and their offsets', async () => {
        const { generateMarkdownToc } = await import('../../engines/web/fetchWebContent.js');
        const markdown = `# Introduction
Some intro text here.

## Quick Start
How to get started.

### Installation
npm install package

## Advanced Guide
Deep dive topics.
`;
        const toc = generateMarkdownToc(markdown);
        expect(toc.length).toBe(4);
        expect(toc[0]).toMatch(/^# Introduction \(\d+\)$/);
        expect(toc[1]).toMatch(/^## Quick Start \(\d+\)$/);
        expect(toc[2]).toMatch(/^### Installation \(\d+\)$/);
        expect(toc[3]).toMatch(/^## Advanced Guide \(\d+\)$/);
    });
});

describe('Substantive tokens in drift & usable results', () => {
    it('should not let a random number bypass hasFirstTokenDrift', async () => {
        const { hasFirstTokenDrift } = await import('../../core/search/resultRanking.js');
        // Query has tail tokens "context", "protocol", and number "2"
        // Results only hit "model" and have a random "2", but zero hit on "context" or "protocol"
        const results = [
            {
                title: 'Tesla Model 2 news',
                url: 'https://example.com/tesla',
                description: 'Model 2 will be released soon with 2 doors',
                source: 'example.com',
                engine: 'bing'
            }
        ];
        expect(hasFirstTokenDrift(results, 'model context protocol 2')).toBe(true);
    });

    it('should not count noise with single digit as usable discriminative term', async () => {
        const { countUsableResults } = await import('../../core/search/resultRanking.js');
        const results = [
            {
                title: 'Article 3',
                url: 'https://example.com/item3',
                description: 'Just mentions 3 apples',
                source: 'example.com',
                engine: 'bing'
            }
        ];
        // Searching for "react performance optimization 3", result only hits "3"
        expect(countUsableResults(results, 'react performance optimization 3')).toBe(0);
    });
});

describe('serializeFetchWebResult links truncation', () => {
    it('should truncate excessive links when overhead is large and stay under byte cap', async () => {
        const { serializeFetchWebResult } = await import('../../tools/toolShared.js');
        const links = Array.from({ length: 300 }, (_, i) => ({
            href: `https://example.com/deep/path/to/resource/item/number/${i}?query=parameter&extra=data`,
            text: `Link text description item #${i} with some long text to take up space`
        }));
        const mockResult = {
            url: 'https://example.com',
            finalUrl: 'https://example.com',
            contentType: 'text/html',
            title: 'Test Page with Many Links',
            retrievalMethod: 'request' as const,
            truncated: false,
            content: 'Hello world, this is a page with many links.'.repeat(20),
            totalLength: 900,
            startIndex: 0,
            links
        };

        const serialized = serializeFetchWebResult(mockResult);
        expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(60 * 1024);
        const parsed = JSON.parse(serialized);
        expect(parsed.links.length).toBeLessThanOrEqual(50);
    });
});


