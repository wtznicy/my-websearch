import { describe, it, expect } from 'vitest';
import {
    getEnv,
    getString,
    getOptionalString,
    getNumber,
    getBoolean,
    getList
} from '../../config/env.js';

describe('config/env 访问层', () => {
    it('getString trims and falls back on empty', () => {
        const env = { A: '  value  ', B: '   ' };
        expect(getString('A', 'fb', env)).toBe('value');
        expect(getString('B', 'fb', env)).toBe('fb');
        expect(getString('MISSING', 'fb', env)).toBe('fb');
    });

    it('getOptionalString returns undefined for blank/missing', () => {
        const env = { A: ' x ', B: '' };
        expect(getOptionalString('A', env)).toBe('x');
        expect(getOptionalString('B', env)).toBeUndefined();
        expect(getOptionalString('MISSING', env)).toBeUndefined();
        expect(getEnv('MISSING', env)).toBeUndefined();
    });

    it('getNumber rejects non-finite and clamps to min/max', () => {
        const env = { N: '42', BAD: 'abc', LOW: '-5', HIGH: '999', F: '3.9' };
        expect(getNumber('N', 1, {}, env)).toBe(42);
        expect(getNumber('BAD', 7, {}, env)).toBe(7);
        expect(getNumber('LOW', 7, { min: 0 }, env)).toBe(0);
        expect(getNumber('HIGH', 7, { max: 100 }, env)).toBe(100);
        expect(getNumber('F', 7, { integer: true }, env)).toBe(3);
        expect(getNumber('MISSING', 7, {}, env)).toBe(7);
    });

    it('getBoolean accepts common truthy/falsy spellings', () => {
        const env = { A: '1', B: 'TRUE', C: 'on', D: '0', E: 'no', F: 'off', G: 'maybe' };
        expect(getBoolean('A', false, env)).toBe(true);
        expect(getBoolean('B', false, env)).toBe(true);
        expect(getBoolean('C', false, env)).toBe(true);
        expect(getBoolean('D', true, env)).toBe(false);
        expect(getBoolean('E', true, env)).toBe(false);
        expect(getBoolean('F', true, env)).toBe(false);
        expect(getBoolean('G', true, env)).toBe(true);
        expect(getBoolean('MISSING', false, env)).toBe(false);
    });

    it('getList splits, trims and filters empties', () => {
        const env = { L: ' a, b ,, c ', EMPTY: '  ' };
        expect(getList('L', ['fb'], env)).toEqual(['a', 'b', 'c']);
        expect(getList('EMPTY', ['fb'], env)).toEqual(['fb']);
        expect(getList('MISSING', ['fb'], env)).toEqual(['fb']);
    });
});
