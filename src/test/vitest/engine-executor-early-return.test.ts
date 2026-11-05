import { describe, expect, it } from 'vitest';
import { executePrimaryEngines } from '../../core/search/engineExecutor.js';
import type { SearchResult } from '../../types.js';

/**
 * 「满意即止」回归：主引擎并行时，只要已完成引擎的去重结果数达到目标，
 * 就给未完成引擎一个宽限窗口后直接返回，避免最慢引擎拖满整次搜索。
 * 单引擎必须不启用早退（用户点名了一个引擎，就该给它完整预算）。
 */

const result = (url: string, engine = 'fast'): SearchResult => ({
    title: url,
    url,
    description: '',
    source: 'example.com',
    engine
});

const makeOptions = (engineMap: Record<string, (query: string, limit: number, ctx?: { signal?: AbortSignal }) => Promise<SearchResult[]>>, overrides: Record<string, unknown> = {}) => ({
    query: 'q',
    searchQuery: 'q',
    executableEngines: Object.keys(engineMap),
    limits: Object.keys(engineMap).map(() => 5),
    engineMap,
    deadlineAt: Date.now() + 30_000,
    perEngineTimeoutMs: 10_000,
    ...overrides
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('executePrimaryEngines early return', () => {
    it('returns once enough results are collected instead of waiting for the slow engine', async () => {
        let slowAborted = false;
        const startedAt = Date.now();

        const resultPromise = executePrimaryEngines(makeOptions({
            fast: async () => [result('a'), result('b'), result('c'), result('d'), result('e')],
            slow: async (_q: string, _l: number, ctx?: { signal?: AbortSignal }) => {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, 5000);
                    ctx?.signal?.addEventListener('abort', () => {
                        slowAborted = true;
                        clearTimeout(timer);
                        resolve();
                    }, { once: true });
                });
                return [];
            }
        }, { satisfiedResults: 3 }));

        const value = await resultPromise;
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(3000);
        expect(value.earlyReturn).toBe(true);
        expect(value.engineResults[0]?.length).toBe(5);
        expect(slowAborted).toBe(true);
        // 被取消的引擎仍要可见（cancelled: true），不能凭空消失
        expect(value.engineMetrics.find((metric) => metric.engine === 'slow')?.cancelled).toBe(true);
        expect(value.cancelledEngines?.map((item) => item.engine)).toContain('slow');
    });

    it('waits for all engines when results are still insufficient', async () => {
        const startedAt = Date.now();
        const value = await executePrimaryEngines(makeOptions({
            fast: async () => [result('a')],
            slow: async () => {
                await sleep(600);
                return [result('b'), result('c')];
            }
        }, { satisfiedResults: 3 }));

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550);
        expect(value.earlyReturn).toBeUndefined();
        expect(value.engineResults.flat()).toHaveLength(3);
    });

    it('does not early-return on results the final filters would drop (site/placeholder)', async () => {
        const startedAt = Date.now();
        const value = await executePrimaryEngines(makeOptions({
            fast: async () => [result('a'), result('b'), result('c')],
            slow: async () => {
                await sleep(400);
                return [result('d')];
            }
        }, {
            satisfiedResults: 3,
            // 模拟 site: 约束把 fast 的结果全过滤掉：净计数为 0，不该提前 abort slow
            countableResult: () => false
        }));

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
        expect(value.earlyReturn).toBeUndefined();
        expect(value.engineResults.flat().length).toBeGreaterThanOrEqual(4);
    });

    it('never early-returns for a single engine even when results are sufficient', async () => {
        const value = await executePrimaryEngines(makeOptions({
            only: async () => {
                await sleep(400);
                return [result('a'), result('b'), result('c')];
            }
        }, { satisfiedResults: 1 }));

        expect(value.earlyReturn).toBeUndefined();
        expect(value.engineResults[0]).toHaveLength(3);
    });

    it('extends grace to 1500ms when results are from a single source, allowing slow engine to return within 1200ms', async () => {
        let slowAborted = false;
        const startedAt = Date.now();

        // fast returns 3 results from juejin.cn (single engine, single domain)
        // slow takes 1100ms (which is > 800ms old grace, but < 1500ms new single source grace)
        const value = await executePrimaryEngines(makeOptions({
            fast: async () => [
                result('https://juejin.cn/post/1', 'fast'),
                result('https://juejin.cn/post/2', 'fast'),
                result('https://juejin.cn/post/3', 'fast')
            ],
            slow: async (_q: string, _l: number, ctx?: { signal?: AbortSignal }) => {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, 1100);
                    ctx?.signal?.addEventListener('abort', () => {
                        slowAborted = true;
                        clearTimeout(timer);
                        resolve();
                    }, { once: true });
                });
                return [result('https://bing.com/search?q=1', 'slow')];
            }
        }, { satisfiedResults: 2 }));

        const elapsed = Date.now() - startedAt;
        expect(slowAborted).toBe(false);
        expect(value.engineResults[1]).toHaveLength(1);
        expect(elapsed).toBeGreaterThanOrEqual(1050);
    });

    it('does not trigger early return when results are irrelevant to the query according to countUsableResults', async () => {
        let slowCompleted = false;
        const startedAt = Date.now();

        // query is "vitest configuration", but fast returns irrelevant "windows bluetooth" results
        const value = await executePrimaryEngines(makeOptions({
            fast: async () => [
                {
                    title: 'Windows Bluetooth Driver Support',
                    url: 'https://example.com/bt-1',
                    description: 'Wireless bluetooth adapter config',
                    source: 'example.com',
                    engine: 'fast'
                },
                {
                    title: 'Bluetooth Headset Configuration',
                    url: 'https://example.com/bt-2',
                    description: 'Windows 11 audio device setup',
                    source: 'example.com',
                    engine: 'fast'
                }
            ],
            slow: async () => {
                await sleep(1000);
                slowCompleted = true;
                return [{
                    title: 'Vitest Official Documentation',
                    url: 'https://vitest.dev/config',
                    description: 'Vitest configuration and setup guide',
                    source: 'vitest.dev',
                    engine: 'slow'
                }];
            }
        }, {
            query: 'Vitest configuration',
            searchQuery: 'Vitest configuration',
            satisfiedResults: 2
        }));

        expect(slowCompleted).toBe(true);
        expect(value.engineResults[1]).toHaveLength(1);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(950);
    });
});
