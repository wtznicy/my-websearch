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

