import { describe, it, expect } from 'vitest';
import {
    normalizeDateToIso,
    isDateWithinTimeRange,
    getTimeRangeCutoffDate
} from '../../utils/dateNormalizer.js';

describe('Date Normalization & Time Range Filtering', () => {
    it('normalizes standard ISO date strings to YYYY-MM-DD', () => {
        expect(normalizeDateToIso('2026-10-17T08:30:00Z')).toBe('2026-10-17');
        expect(normalizeDateToIso('2026-05-01')).toBe('2026-05-01');
        expect(normalizeDateToIso('2026/12/31')).toBe('2026-12-31');
    });

    it('normalizes natural language relative dates (English)', () => {
        const now = new Date('2026-10-18T12:00:00Z');
        expect(normalizeDateToIso('3 days ago', now)).toBe('2026-10-15');
        expect(normalizeDateToIso('yesterday', now)).toBe('2026-10-17');
        expect(normalizeDateToIso('2 hours ago', now)).toBe('2026-10-18');
        expect(normalizeDateToIso('1 week ago', now)).toBe('2026-10-11');
        expect(normalizeDateToIso('1 month ago', now)).toBe('2026-09-18');
    });

    it('normalizes natural language relative dates (Chinese)', () => {
        const now = new Date('2026-10-18T12:00:00Z');
        expect(normalizeDateToIso('3天前', now)).toBe('2026-10-15');
        expect(normalizeDateToIso('昨天', now)).toBe('2026-10-17');
        expect(normalizeDateToIso('2小时前', now)).toBe('2026-10-18');
        expect(normalizeDateToIso('1个月前', now)).toBe('2026-09-18');
    });

    it('filters dates correctly according to timeRange window', () => {
        const now = new Date('2026-10-18T12:00:00Z');

        // day: within 24h
        expect(isDateWithinTimeRange('2026-10-18', 'day', now)).toBe(true);
        expect(isDateWithinTimeRange('2026-10-17', 'day', now)).toBe(true);
        expect(isDateWithinTimeRange('2026-10-10', 'day', now)).toBe(false);

        // week: within 7 days
        expect(isDateWithinTimeRange('2026-10-12', 'week', now)).toBe(true);
        expect(isDateWithinTimeRange('2026-10-01', 'week', now)).toBe(false);

        // month: within 30 days
        expect(isDateWithinTimeRange('2026-09-25', 'month', now)).toBe(true);
        expect(isDateWithinTimeRange('2026-08-01', 'month', now)).toBe(false);

        // year: within 365 days
        expect(isDateWithinTimeRange('2026-01-01', 'year', now)).toBe(true);
        expect(isDateWithinTimeRange('2024-01-01', 'year', now)).toBe(false);
    });

    it('rejects invalid or undefined dates', () => {
        expect(normalizeDateToIso('')).toBeUndefined();
        expect(normalizeDateToIso('not a valid date')).toBeUndefined();
        expect(isDateWithinTimeRange(undefined, 'day')).toBe(false);
    });
});
