import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    computeContext7RetryDelayMs,
    context7GetWithRetry,
    isContext7QuotaExhaustedError
} from '../../engines/context7/context7.js';

type AxiosLikeError = Error & { response: { status: number; headers: Record<string, unknown>; data?: unknown } };

function axiosLikeError(status: number, headers: Record<string, unknown> = {}, data?: unknown): AxiosLikeError {
    const error = new Error(`Request failed with status code ${status}`) as AxiosLikeError;
    error.response = { status, headers, data };
    return error;
}

/** 月度匿名配额耗尽的真实响应形态（2026-09-25 实测抓取） */
function quotaExhaustedError(): AxiosLikeError {
    return axiosLikeError(429, {
        'ratelimit-limit': '200',
        'ratelimit-remaining': '0',
        'ratelimit-reset': '1790812800', // 2026-10-01T00:00:00Z
        'retry-after': '499415' // ≈5.8 天，盲从即挂死数天
    }, {
        error: 'Quota Exceeded',
        message: 'Monthly quota exceeded. Create a free API key at https://context7.com/dashboard for more requests.'
    });
}

afterEach(() => {
    vi.useRealTimers();
});

describe('isContext7QuotaExhaustedError', () => {
    it('detects quota exhaustion from the response body', () => {
        expect(isContext7QuotaExhaustedError(quotaExhaustedError())).toBe(true);
    });

    it('detects quota exhaustion from headers alone (remaining=0 + multi-hour retry-after)', () => {
        expect(isContext7QuotaExhaustedError(axiosLikeError(429, {
            'ratelimit-remaining': '0',
            'retry-after': '499415'
        }))).toBe(true);
    });

    it('treats an ordinary transient 429 as retryable, not quota exhaustion', () => {
        expect(isContext7QuotaExhaustedError(axiosLikeError(429, {
            'ratelimit-remaining': '42',
            'retry-after': '5'
        }))).toBe(false);
    });

    it('ignores non-429 statuses', () => {
        expect(isContext7QuotaExhaustedError(axiosLikeError(500, { 'ratelimit-remaining': '0', 'retry-after': '499415' }))).toBe(false);
        expect(isContext7QuotaExhaustedError(axiosLikeError(404))).toBe(false);
    });

    it('detects the already-converted terminal error (tool layer hint selection)', () => {
        expect(isContext7QuotaExhaustedError(new Error('Context7 anonymous quota exhausted (200 requests/month per egress IP).'))).toBe(true);
        expect(isContext7QuotaExhaustedError(new Error('some other failure'))).toBe(false);
        expect(isContext7QuotaExhaustedError(undefined)).toBe(false);
    });
});

describe('computeContext7RetryDelayMs', () => {
    it('caps Retry-After so an upstream multi-day window cannot hang the call', () => {
        expect(computeContext7RetryDelayMs(499415, 0, 1500)).toBe(2000);
    });

    it('honors a short Retry-After as-is', () => {
        expect(computeContext7RetryDelayMs(1, 0, 1500)).toBe(1000);
    });

    it('falls back to jittered exponential backoff when Retry-After is absent or invalid', () => {
        const delay = computeContext7RetryDelayMs(Number('not-a-number'), 1, 800);
        expect(delay).toBeGreaterThanOrEqual(1600);
        expect(delay).toBeLessThan(1850);
    });
});

describe('context7GetWithRetry', () => {
    it('fails fast on quota exhaustion without retrying (no multi-day sleep)', async () => {
        const get = vi.fn().mockRejectedValue(quotaExhaustedError());

        const error = await context7GetWithRetry('https://context7.com/api/v2/libs/search', {}, 3, get)
            .catch((e: Error) => e);

        expect(get).toHaveBeenCalledTimes(1); // 终态：不重试
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Context7 anonymous quota exhausted');
        expect((error as Error).message).toContain('2026-10-01'); // 重置日期来自 ratelimit-reset
        expect(isContext7QuotaExhaustedError(error)).toBe(true); // 工具层 hint 分支能命中
    });

    it('bounds total retry wait even when Retry-After is huge but not quota exhaustion', async () => {
        vi.useFakeTimers();
        const get = vi.fn().mockRejectedValue(axiosLikeError(429, {
            'ratelimit-remaining': '7',
            'retry-after': '86400' // 1 天——封顶后每次最多等 2s
        }));

        const promise = context7GetWithRetry('https://context7.com/api/v2/libs/search', {}, 3, get)
            .catch((e: Error) => e);
        await vi.advanceTimersByTimeAsync(10_000); // 远小于 86400s
        const error = await promise;

        expect(get).toHaveBeenCalledTimes(3);
        expect((error as Error).message).toContain('rate limit reached (429)');
    });

    it('retries 5xx with backoff and returns the first success', async () => {
        vi.useFakeTimers();
        const get = vi.fn()
            .mockRejectedValueOnce(axiosLikeError(500))
            .mockRejectedValueOnce(axiosLikeError(503))
            .mockResolvedValueOnce({ status: 200, data: { results: [] } });

        const promise = context7GetWithRetry('https://context7.com/api/v2/context', {}, 3, get);
        await vi.advanceTimersByTimeAsync(5_000);
        const response = await promise;

        expect(response.status).toBe(200);
        expect(get).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-retryable statuses', async () => {
        const get = vi.fn().mockRejectedValue(axiosLikeError(404));

        const error = await context7GetWithRetry('https://context7.com/api/v2/context', {}, 3, get)
            .catch((e: Error) => e);

        expect(get).toHaveBeenCalledTimes(1);
        expect((error as Error).message).toContain('404');
    });

    it('forwards request params to the injected get implementation', async () => {
        const get = vi.fn().mockResolvedValue({ status: 200, data: {} });

        await context7GetWithRetry('https://context7.com/api/v2/context', { params: { libraryId: '/vercel/next.js' } }, 3, get);

        expect(get).toHaveBeenCalledWith('https://context7.com/api/v2/context', { libraryId: '/vercel/next.js' });
    });
});

import { pickBestLibrary, createContext7Services, resetContext7Cache } from '../../core/context7/context7Service.js';
import * as context7Engine from '../../engines/context7/context7.js';

describe('pickBestLibrary and smart Context7DocsService resolution', () => {
    afterEach(() => {
        resetContext7Cache();
        vi.restoreAllMocks();
    });

    it('prioritizes exact name match over slightly higher scored partial match', () => {
        const candidates: context7Engine.Context7Library[] = [
            {
                id: '/user/react-native-router',
                title: 'react-native-router',
                description: 'A router',
                versions: ['1.0'],
                trustScore: 9,
                benchmarkScore: 9,
                totalSnippets: 100
            },
            {
                id: '/facebook/react',
                title: 'React',
                description: 'The library for web and native user interfaces',
                versions: ['18.0'],
                trustScore: 8,
                benchmarkScore: 8,
                totalSnippets: 50
            }
        ];

        const best = pickBestLibrary(candidates, 'react');
        expect(best?.id).toBe('/facebook/react');
    });

    it('ranks by trustScore and snippet richness when no exact title match', () => {
        const candidates: context7Engine.Context7Library[] = [
            {
                id: '/org/low-quality',
                title: 'Something Router',
                description: 'Low quality',
                versions: ['1.0'],
                trustScore: 2,
                benchmarkScore: 1,
                totalSnippets: 5
            },
            {
                id: '/remix-run/react-router',
                title: 'React Router',
                description: 'Declarative routing for React',
                versions: ['6.0'],
                trustScore: 9,
                benchmarkScore: 8,
                totalSnippets: 300
            }
        ];

        const best = pickBestLibrary(candidates, 'router');
        expect(best?.id).toBe('/remix-run/react-router');
    });

    it('auto-resolves natural library name and enriches docs result with alternatives', async () => {
        const mockSearch = vi.spyOn(context7Engine, 'searchContext7Libraries').mockResolvedValue({
            query: 'next.js',
            libraryName: 'next.js',
            results: [
                {
                    id: '/vercel/next.js',
                    title: 'Next.js',
                    description: 'The React Framework for the Web',
                    versions: ['15.0'],
                    trustScore: 10,
                    totalSnippets: 500
                },
                {
                    id: '/alternative/next-lite',
                    title: 'Next Lite',
                    description: 'Lite version',
                    versions: ['1.0'],
                    trustScore: 5
                }
            ]
        });

        const mockFetch = vi.spyOn(context7Engine, 'fetchContext7Docs').mockResolvedValue({
            libraryId: '/vercel/next.js',
            query: 'middleware',
            codeSnippets: [{ codeTitle: 'Middleware example', codeList: [{ code: 'export function middleware() {}' }] }],
            infoSnippets: []
        });

        const services = createContext7Services();
        const res = await services.docs.execute({ library: 'next.js', query: 'middleware' });

        expect(mockSearch).toHaveBeenCalledWith('next.js', 'middleware', 5);
        expect(mockFetch).toHaveBeenCalledWith('/vercel/next.js', 'middleware', 5);
        expect(res.libraryId).toBe('/vercel/next.js');
        expect(res.resolvedFrom).toBe('next.js');
        expect(res.alternativeLibraries).toHaveLength(1);
        expect(res.alternativeLibraries?.[0].id).toBe('/alternative/next-lite');
    });

    it('heals 404 on blind guessed /tailwind/tailwindcss by extracting tailwindcss', async () => {
        const mockFetch = vi.spyOn(context7Engine, 'fetchContext7Docs')
            .mockRejectedValueOnce(new Error('Request failed with status code 404'))
            .mockResolvedValueOnce({
                libraryId: '/tailwindlabs/tailwindcss',
                query: 'flex',
                codeSnippets: [{ codeTitle: 'Flexbox', codeList: [{ code: 'class="flex"' }] }],
                infoSnippets: []
            });

        const mockSearch = vi.spyOn(context7Engine, 'searchContext7Libraries').mockResolvedValue({
            query: 'tailwindcss',
            libraryName: 'tailwindcss',
            results: [
                {
                    id: '/tailwindlabs/tailwindcss',
                    title: 'Tailwind CSS',
                    description: 'A utility-first CSS framework',
                    versions: ['3.4'],
                    trustScore: 10
                }
            ]
        });

        const services = createContext7Services();
        const res = await services.docs.execute({ library: '/tailwind/tailwindcss', query: 'flex' });

        expect(res.libraryId).toBe('/tailwindlabs/tailwindcss');
        expect(res.resolvedFrom).toBe('/tailwind/tailwindcss');
    });
});
