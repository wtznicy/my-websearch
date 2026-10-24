import { describe, expect, it } from 'vitest';
import { parseLineRangeFromUrl, parseLineRangeInput, sliceCodeLines } from '../../engines/github/lineRange.js';
import { formatSourceFile } from '../../engines/github/format.js';

describe('GitHub line ranges', () => {
    it('parses explicit ranges', () => {
        expect(parseLineRangeInput('120-180')).toEqual({ start: 120, end: 180 });
        expect(parseLineRangeInput('L120-L180')).toEqual({ start: 120, end: 180 });
        expect(parseLineRangeInput('42')).toEqual({ start: 42, end: 42 });
    });

    it('parses URL hashes', () => {
        expect(parseLineRangeFromUrl('https://github.com/o/r/blob/main/src/a.ts#L120-L180'))
            .toEqual({ start: 120, end: 180 });
        expect(parseLineRangeFromUrl('https://github.com/o/r/blob/main/src/a.ts#L7'))
            .toEqual({ start: 7, end: 7 });
    });

    it('rejects malformed and out-of-bounds ranges', () => {
        expect(() => parseLineRangeInput('abc')).toThrow();
        expect(() => parseLineRangeInput('10-5')).toThrow();
        expect(() => sliceCodeLines('a\nb\nc', { start: 10, end: 20 })).toThrow();
    });

    it('slices inclusive ranges and caps at 400 lines', () => {
        const content = Array.from({ length: 600 }, (_, i) => `line-${i + 1}`).join('\n');
        const normal = sliceCodeLines(content, { start: 100, end: 102 });
        expect(normal.lines).toEqual(['line-100', 'line-101', 'line-102']);
        expect(normal.truncated).toBe(false);

        const capped = sliceCodeLines(content, { start: 1, end: 600 });
        expect(capped.lines).toHaveLength(400);
        expect(capped.truncated).toBe(true);
    });

    it('formats sliced code with real line numbers', () => {
        const formatted = formatSourceFile('o', 'r', 'main', 'src/a.ts', 'alpha\nbeta\ngamma', { start: 2, end: 3 });
        expect(formatted).toContain('lines 2-3 of 3');
        expect(formatted).toContain('2 | beta');
        expect(formatted).toContain('3 | gamma');
        expect(formatted).not.toContain('1 | alpha');
    });
});
