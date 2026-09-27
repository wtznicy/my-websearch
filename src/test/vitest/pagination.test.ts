import { describe, it, expect, vi } from 'vitest';
import { paginateSearch } from '../../utils/pagination.js';

describe('paginateSearch', () => {
    it('returns empty array when first page is empty', async () => {
        const fetchPage = vi.fn().mockResolvedValue([]);
        const results = await paginateSearch({
            limit: 10,
            fetchPage
        });

        expect(results).toEqual([]);
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('stops once limit is reached within a single page', async () => {
        const fetchPage = vi.fn().mockResolvedValue([
            { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }
        ]);

        const results = await paginateSearch({
            limit: 3,
            fetchPage
        });

        expect(results).toHaveLength(3);
        expect(results).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('fetches multiple pages until limit is satisfied', async () => {
        const fetchPage = vi.fn()
            .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
            .mockResolvedValueOnce([{ id: 3 }, { id: 4 }])
            .mockResolvedValueOnce([{ id: 5 }, { id: 6 }]);

        const results = await paginateSearch<{ id: number }>({
            limit: 5,
            initialPage: 1,
            pageStep: 1,
            fetchPage
        });

        expect(results).toHaveLength(5);
        expect(results.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
        expect(fetchPage).toHaveBeenCalledTimes(3);
        expect(fetchPage).toHaveBeenNthCalledWith(1, 1);
        expect(fetchPage).toHaveBeenNthCalledWith(2, 2);
        expect(fetchPage).toHaveBeenNthCalledWith(3, 3);
    });

    it('deduplicates items using dedupKey and terminates early on zero additions', async () => {
        const fetchPage = vi.fn()
            .mockResolvedValueOnce([{ id: 'a', url: 'https://a.com' }, { id: 'b', url: 'https://b.com' }])
            // Second page returns duplicate URLs
            .mockResolvedValueOnce([{ id: 'a2', url: 'https://a.com' }, { id: 'b2', url: 'https://b.com' }])
            // Should not reach third page
            .mockResolvedValueOnce([{ id: 'c', url: 'https://c.com' }]);

        const results = await paginateSearch<{ id: string; url: string }>({
            limit: 10,
            fetchPage,
            dedupKey: (item) => item.url
        });

        expect(results).toHaveLength(2);
        expect(results.map((r) => r.id)).toEqual(['a', 'b']);
        expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it('respects maxPages limit', async () => {
        const fetchPage = vi.fn().mockResolvedValue([{ id: 1 }]);

        const results = await paginateSearch({
            limit: 100,
            maxPages: 3,
            fetchPage
        });

        expect(results).toHaveLength(3);
        expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it('preserves directAnswer property if attached to page results', async () => {
        const page1 = [{ id: 1 }];
        (page1 as any).directAnswer = '42';

        const fetchPage = vi.fn()
            .mockResolvedValueOnce(page1)
            .mockResolvedValueOnce([]);

        const results = await paginateSearch({
            limit: 5,
            fetchPage
        });

        expect(results).toHaveLength(1);
        expect((results as any).directAnswer).toBe('42');
    });
});
