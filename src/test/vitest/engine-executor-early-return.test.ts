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
        // 被跳过的引擎不应出现在 metric 里
        expect(value.engineMetrics.some((metric) => metric.engine === 'slow')).toBe(false);
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
});
