import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { detectUnknownParameters } from '../../utils/toolValidation.js';
import { createRequestContext, DefaultRequestContext } from '../../core/requestContext.js';
import { searchGithub } from '../../engines/github/githubSearch.js';
import { searchStackOverflow } from '../../engines/stackoverflow/stackoverflow.js';
import { searchHackerNews } from '../../engines/hackernews/hackernews.js';
import { searchArxiv } from '../../engines/arxiv/arxiv.js';

describe('detectUnknownParameters helper', () => {
    it('returns empty array when all keys are known', () => {
        const raw = { query: 'test', limit: 5 };
        const warnings = detectUnknownParameters(raw, ['query', 'limit']);
        expect(warnings).toEqual([]);
    });

    it('returns empty array for empty or non-object input', () => {
        expect(detectUnknownParameters(null, ['query'])).toEqual([]);
        expect(detectUnknownParameters(undefined, ['query'])).toEqual([]);
        expect(detectUnknownParameters('invalid', ['query'])).toEqual([]);
        expect(detectUnknownParameters([], ['query'])).toEqual([]);
    });

    it('detects unknown parameters and formats human-readable warning', () => {
        const raw = { query: 'test', foo: 123, bar: 'baz' };
        const warnings = detectUnknownParameters(raw, ['query', 'limit']);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("Unknown parameter(s) ignored: 'foo', 'bar'");
        expect(warnings[0]).toContain('query, limit');
    });
});

describe('RequestContext lifecycle & helpers', () => {
    it('creates context with default options and unique traceId', () => {
        const rc = createRequestContext();
        expect(rc).toBeInstanceOf(DefaultRequestContext);
        expect(rc.traceId).toBeDefined();
        expect(rc.warnings).toEqual([]);
        expect(rc.isExpired()).toBe(false);
    });

    it('supports createRequestContext with options object or AbortSignal', () => {
        const controller = new AbortController();
        const rc1 = createRequestContext(controller.signal, { timeoutMs: 5000 });
        expect(rc1.signal).toBe(controller.signal);
        expect(rc1.remainingMs()).toBeGreaterThan(0);

        const rc2 = createRequestContext({ signal: controller.signal, timeoutMs: 3000 });
        expect(rc2.signal).toBe(controller.signal);
        expect(rc2.remainingMs()).toBeGreaterThan(0);
    });

    it('manages warnings uniquely', () => {
        const rc = createRequestContext();
        rc.addWarning('Warning A');
        rc.addWarning('Warning A');
        rc.addWarning('Warning B');
        expect(rc.warnings).toEqual(['Warning A', 'Warning B']);
    });

    it('tracks expiration on deadline or abort', () => {
        const rc = createRequestContext({ timeoutMs: -100 });
        expect(rc.isExpired()).toBe(true);

        const controller = new AbortController();
        const rc2 = createRequestContext({ signal: controller.signal, timeoutMs: 60000 });
        expect(rc2.isExpired()).toBe(false);
        controller.abort();
        expect(rc2.isExpired()).toBe(true);
    });
});

describe('Native Engine timeRange parameter mapping', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('GitHub search appends created:>=YYYY-MM-DD when timeRange is provided', async () => {
        const requestSpy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { total_count: 0, items: [] },
            headers: {}
        });

        await searchGithub('react', 5, { timeRange: 'week' });
        expect(requestSpy).toHaveBeenCalled();
        const firstCallArgs = requestSpy.mock.calls[0][0];
        const githubParams = firstCallArgs.params as Record<string, string> | undefined;
        expect(githubParams?.q).toMatch(/react created:>=/);
    });

    it('StackOverflow search passes fromdate in seconds when timeRange is provided', async () => {
        const requestSpy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { items: [], has_more: false },
            headers: {}
        });

        await searchStackOverflow('typescript', 5, { timeRange: 'month' });
        expect(requestSpy).toHaveBeenCalled();
        const callArgs = requestSpy.mock.calls[0][0];
        const params = callArgs.params as Record<string, number> | undefined;
        expect(params?.fromdate).toBeDefined();
        expect(typeof params?.fromdate).toBe('number');
        expect(Number(params?.fromdate)).toBeGreaterThan(0);
    });

    it('HackerNews search passes numericFilters created_at_i>= when timeRange is provided', async () => {
        const requestSpy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { hits: [], nbHits: 0 },
            headers: {}
        });

        await searchHackerNews('ai', 5, { timeRange: 'day' });
        expect(requestSpy).toHaveBeenCalled();
        const callArgs = requestSpy.mock.calls[0][0];
        const params = callArgs.params as Record<string, string> | undefined;
        expect(params?.numericFilters).toMatch(/^created_at_i>=\d+$/);
    });

    it('arXiv search appends submittedDate when timeRange is provided', async () => {
        const requestSpy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
            headers: {}
        });

        await searchArxiv('quantum computing', 5, { timeRange: 'year' });
        expect(requestSpy).toHaveBeenCalled();
        const callArgs = requestSpy.mock.calls[0][0];
        const params = callArgs.params as Record<string, string> | undefined;
        expect(params?.search_query).toMatch(/AND submittedDate:\[\d{8}0000 TO \d{8}2359\]/);
    });

    it('Exa search passes startPublishedDate in ISO format when timeRange is provided', async () => {
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            status: 200,
            data: { results: [] },
            headers: {}
        });
        const prevKey = process.env.EXA_API_KEY;
        process.env.EXA_API_KEY = 'mock_key';
        try {
            const { searchExa } = await import('../../engines/exa/exa.js');
            await searchExa('deep learning', 5, { timeRange: 'week' });
            expect(postSpy).toHaveBeenCalled();
            const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
            expect(body.startPublishedDate).toBeDefined();
            expect(typeof body.startPublishedDate).toBe('string');
            expect((body.startPublishedDate as string).endsWith('Z')).toBe(true);
        } finally {
            if (prevKey) {
                process.env.EXA_API_KEY = prevKey;
            } else {
                delete process.env.EXA_API_KEY;
            }
        }
    });

    it('Brave official search appends freshness parameter when timeRange is provided', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: { web: { results: [] } },
            headers: {}
        });
        const { searchBraveOfficial } = await import('../../engines/brave/brave.js');
        await searchBraveOfficial('playwright', 5, 'mock_token', undefined, 'day');
        expect(getSpy).toHaveBeenCalled();
        const requestUrl = getSpy.mock.calls[0][0] as string;
        expect(requestUrl).toContain('freshness=pd');
    });
});
