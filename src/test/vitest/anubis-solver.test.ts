import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import {
    solveAnubisPow,
    parseAnubisChallenge,
    extractStartpageScToken
} from '../../engines/startpage/anubisSolver.js';

describe('solveAnubisPow', () => {
    it('should find a nonce whose sha256(randomData+nonce) has the required zero prefix', () => {
        const randomData = 'test-random-data-123';
        const result = solveAnubisPow(randomData, 3);
        expect(result).not.toBeNull();
        const hash = crypto.createHash('sha256').update(`${randomData}${result!.nonce}`).digest('hex');
        expect(hash).toBe(result!.hash);
        expect(hash.startsWith('000')).toBe(true);
    });

    it('should verify the returned hash matches the nonce for a real-shaped challenge', () => {
        const result = solveAnubisPow('01a0c924-0f1a-76a5-b370-6422389c2d2e', 4);
        expect(result).not.toBeNull();
        expect(result!.hash.startsWith('0000')).toBe(true);
    });
});

describe('parseAnubisChallenge', () => {
    const REAL_SHAPED_HTML = `<html><body>
<script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast","difficulty":4},"challenge":{"issuedAt":"2026-09-22T12:42:58Z","metadata":{"User-Agent":"x"},"id":"01a0c924-0f1a-76a5-b370-6422389c2d2e","randomData":"random-data-value","method":"fast"}}</script>
</body></html>`;

    it('should parse id, randomData and difficulty from the challenge payload', () => {
        const parsed = parseAnubisChallenge(REAL_SHAPED_HTML);
        expect(parsed).toEqual({
            id: '01a0c924-0f1a-76a5-b370-6422389c2d2e',
            randomData: 'random-data-value',
            difficulty: 4
        });
    });

    it('should fall back to id as randomData when randomData is missing', () => {
        const html = '<script id="anubis_challenge">{"rules":{"difficulty":4},"challenge":{"id":"abc-123"}}</script>';
        expect(parseAnubisChallenge(html)).toEqual({ id: 'abc-123', randomData: 'abc-123', difficulty: 4 });
    });

    it('should return null for pages without a challenge (already passed / blocked)', () => {
        expect(parseAnubisChallenge('<html><body>Startpage Blocked</body></html>')).toBeNull();
        expect(parseAnubisChallenge('<script id="anubis_challenge">not-json</script>')).toBeNull();
    });
});

describe('extractStartpageScToken', () => {
    it('should extract sc from both attribute orders', () => {
        expect(extractStartpageScToken('<input name="sc" value="token-a">')).toBe('token-a');
        expect(extractStartpageScToken('<input value="token-b" name="sc">')).toBe('token-b');
    });

    it('should return undefined when no sc token is present', () => {
        expect(extractStartpageScToken('<html>challenge page</html>')).toBeUndefined();
    });
});
