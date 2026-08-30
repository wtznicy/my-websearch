import { describe, it, expect } from 'vitest';
import { parseExaResults, cleanExaDescription } from '../../engines/exa/exa.js';

const API_RESULTS = [
    {
        id: '1',
        title: 'First',
        url: 'https://example.com/one',
        text: 'Hello <b>world</b> &amp; more 内容'
    },
    {
        id: '2',
        title: 'Second',
        url: 'https://example.org/two',
        author: 'Bob',
        publishedDate: '2024-01-15'
    }
];

describe('parseExaResults', () => {
    it('should map results with cleaned text description', () => {
        const results = parseExaResults(API_RESULTS, 10);

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            title: 'First',
            url: 'https://example.com/one',
            description: 'Hello world & more 内容',
            source: 'example.com',
            engine: 'exa'
        });
    });

    it('should fall back to Author/Published summary when no text', () => {
        const results = parseExaResults(API_RESULTS, 10);
        expect(results[1].description).toContain('Author: Bob');
        expect(results[1].source).toBe('example.org');
    });

    it('should respect the limit', () => {
        expect(parseExaResults(API_RESULTS, 1)).toHaveLength(1);
    });

    it('should return empty array for empty/missing results', () => {
        expect(parseExaResults([], 10)).toEqual([]);
        expect(parseExaResults(undefined as never, 10)).toEqual([]);
    });

    it('should use "No title" placeholder for missing title', () => {
        const results = parseExaResults([{ id: '3', title: '', url: 'https://example.com/three', text: 'x' }], 10);
        expect(results[0].title).toBe('No title');
    });
});

describe('cleanExaDescription', () => {
    it('should strip HTML tags and decode entities', () => {
        expect(cleanExaDescription('<b>bold</b> &amp; <em>italic</em> &quot;quoted&quot;')).toBe('bold & italic "quoted"');
    });

    it('should collapse whitespace', () => {
        expect(cleanExaDescription('a\n\n  b\t c')).toBe('a b c');
    });

    it('should cap at 300 characters', () => {
        const long = 'x'.repeat(600);
        expect(cleanExaDescription(long)).toHaveLength(300);
    });

    it('should not split emoji surrogate pairs when truncating', () => {
        // 🚀 是代理对（2 个 UTF-16 码元）；298 个 x + 🚀 正好卡在截断边界
        const input = 'x'.repeat(298) + '🚀' + 'y'.repeat(50);
        const result = cleanExaDescription(input);
        expect(Array.from(result)).toHaveLength(300); // 300 个码点（🚀 占 1 个码点、2 个码元）
        expect(result.includes('🚀')).toBe(true); // 代理对完整保留（未被劈开）
        // 无孤立代理对：完整代理对在 Array.from 中是长度 2 的码元；孤立代理码元是长度 1 的代理区码元
        const hasLoneSurrogate = Array.from(result).some((ch) => ch.length === 1 && /[\uD800-\uDFFF]/.test(ch));
        expect(hasLoneSurrogate).toBe(false);
    });
});
