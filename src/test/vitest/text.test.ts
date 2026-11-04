import { describe, it, expect } from 'vitest';
import { normalizeText } from '../../utils/text.js';

describe('utils/text normalizeText', () => {
    it('collapses whitespace and trims edges', () => {
        expect(normalizeText('hello   world')).toBe('hello world');
        expect(normalizeText('line1\nline2')).toBe('line1 line2');
        expect(normalizeText('a\tb')).toBe('a b');
        expect(normalizeText('   leading and trailing   ')).toBe('leading and trailing');
        expect(normalizeText('')).toBe('');
        expect(normalizeText('中文  空格')).toBe('中文 空格');
    });
});
