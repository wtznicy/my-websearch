import { describe, expect, it } from 'vitest';
import { resolveBingDriftOutcome } from '../../engines/bing/bing.js';
import type { SearchResult } from '../../types.js';

/**
 * P1 回归：Bing 首词漂移触发 Playwright 兜底时，兜底失败/超预算绝不能把
 * HTTP 已经拿到的可用结果整批丢弃（实测 auto 模式下 2.9s/3 条 → 12s deadline 时 0 条）。
 */
const result = (url: string): SearchResult => ({
    title: url,
    url,
    description: '',
    source: 'bing.com',
    engine: 'bing'
});

describe('resolveBingDriftOutcome', () => {
    it('prefers Playwright results when the fallback produced some', () => {
        const http = [result('https://example.com/kubernetes')];
        const fallback = [result('https://example.com/operator')];
        expect(resolveBingDriftOutcome(http, fallback)).toEqual({
            results: fallback,
            keptHttpFallback: false
        });
    });

    it('keeps the HTTP results when the fallback timed out or returned nothing', () => {
        const http = [result('https://example.com/kubernetes')];
        for (const fallback of [undefined, [] as SearchResult[]]) {
            expect(resolveBingDriftOutcome(http, fallback)).toEqual({
                results: http,
                keptHttpFallback: true
            });
        }
    });

    it('does not claim a fallback was kept when HTTP produced nothing either', () => {
        expect(resolveBingDriftOutcome([], undefined)).toEqual({
            results: [],
            keptHttpFallback: false
        });
    });
});
