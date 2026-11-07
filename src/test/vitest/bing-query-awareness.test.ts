import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { isChineseQuery, buildBingSearchUrl } from '../../engines/bing/query.js';
import { buildImpersonateSearchUrl } from '../../engines/bing/impersonate.js';
import * as httpSearchModule from '../../engines/bing/httpSearch.js';
import * as browserFallbackModule from '../../engines/bing/browserFallback.js';
import * as launchArgsModule from '../../engines/bing/launchArgs.js';
import * as circuitModule from '../../core/search/engineCircuitBreaker.js';
import { searchBing } from '../../engines/bing/bing.js';
import type { EngineSearchResponse } from '../../types.js';

describe('Bing query awareness and fast recovery', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(circuitModule, 'isEngineCircuitOpen').mockReturnValue(false);
        vi.spyOn(launchArgsModule, 'isPlaywrightAvailable').mockResolvedValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('isChineseQuery', () => {
        it('classifies Chinese and English queries accurately', () => {
            expect(isChineseQuery('React 状态管理')).toBe(true);
            expect(isChineseQuery('你好')).toBe(true);
            expect(isChineseQuery('中文测试')).toBe(true);

            expect(isChineseQuery('react server actions validation')).toBe(false);
            expect(isChineseQuery('python asyncio create_task')).toBe(false);
            expect(isChineseQuery('123456')).toBe(false);
            expect(isChineseQuery('a')).toBe(false);
        });
    });

    describe('buildBingSearchUrl & buildImpersonateSearchUrl', () => {
        it('assigns ensearch=0 and zh-CN for Chinese queries on cn.bing.com', () => {
            const url = buildBingSearchUrl('React 状态管理 教程', 0, undefined, 'https://cn.bing.com/search');
            const parsed = new URL(url);
            expect(parsed.searchParams.get('setlang')).toBe('zh-CN');
            expect(parsed.searchParams.get('ensearch')).toBe('0');

            const impUrl = buildImpersonateSearchUrl('React 状态管理 教程', 0, undefined, 'https://cn.bing.com/search');
            const impParsed = new URL(impUrl);
            expect(impParsed.searchParams.get('setlang')).toBe('zh-CN');
            expect(impParsed.searchParams.get('ensearch')).toBe('0');
        });

        it('assigns en-US and avoids locking ensearch=0 for English queries on cn.bing.com', () => {
            const url = buildBingSearchUrl('react server actions validation', 0, undefined, 'https://cn.bing.com/search');
            const parsed = new URL(url);
            expect(parsed.searchParams.get('setlang')).toBe('en-US');
            expect(parsed.searchParams.get('ensearch')).toBeNull();

            const impUrl = buildImpersonateSearchUrl('react server actions validation', 0, undefined, 'https://cn.bing.com/search');
            const impParsed = new URL(impUrl);
            expect(impParsed.searchParams.get('setlang')).toBe('en-US');
            expect(impParsed.searchParams.get('ensearch')).toBeNull();
        });
    });

    describe('Fast Drift Recovery flow in searchBing', () => {
        it('bypasses Playwright browser launch when fast HTTP drift recovery succeeds', async () => {
            const driftedResults: EngineSearchResponse = [
                {
                    title: 'React',
                    url: 'https://react.dev/',
                    description: 'The library for web and native user interfaces',
                    source: 'react.dev',
                    engine: 'bing'
                }
            ];

            const recoveredResults: EngineSearchResponse = [
                {
                    title: 'React 19 Server Actions Validation Deep Dive',
                    url: 'https://example.com/react-server-actions-validation',
                    description: 'Complete guide to server actions and validation in React',
                    source: 'example.com',
                    engine: 'bing'
                }
            ];

            vi.spyOn(httpSearchModule, 'searchBingWithHttp').mockResolvedValue(driftedResults);
            const recoverSpy = vi.spyOn(httpSearchModule, 'recoverBingDriftWithHttp').mockResolvedValue(recoveredResults);
            const playwrightFallbackSpy = vi.spyOn(browserFallbackModule, 'searchBingWithPlaywrightFallback');

            const results = await searchBing('react server actions validation', 5);

            expect(recoverSpy).toHaveBeenCalledTimes(1);
            expect(playwrightFallbackSpy).not.toHaveBeenCalled();
            expect(results).toEqual(recoveredResults);
        });

        it('falls back to Playwright mode when fast HTTP drift recovery cannot resolve the drift', async () => {
            const driftedResults: EngineSearchResponse = [
                {
                    title: 'Python',
                    url: 'https://python.org/',
                    description: 'Python language',
                    source: 'python.org',
                    engine: 'bing'
                }
            ];

            const playwrightResults: EngineSearchResponse = [
                {
                    title: 'Python Asyncio Create Task Error Handling Guide',
                    url: 'https://example.com/python-asyncio-error-handling',
                    description: 'Handling errors in asyncio tasks',
                    source: 'example.com',
                    engine: 'bing'
                }
            ];

            vi.spyOn(httpSearchModule, 'searchBingWithHttp').mockResolvedValue(driftedResults);
            vi.spyOn(httpSearchModule, 'recoverBingDriftWithHttp').mockResolvedValue(undefined);
            const playwrightFallbackSpy = vi.spyOn(browserFallbackModule, 'searchBingWithPlaywrightFallback').mockResolvedValue(playwrightResults);

            const results = await searchBing('python asyncio create_task error handling', 5);

            expect(playwrightFallbackSpy).toHaveBeenCalledTimes(1);
            expect(results).toEqual(playwrightResults);
        });
    });
});
