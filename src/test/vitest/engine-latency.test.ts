import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    percentile,
    readEngineLatencyStats,
    recordEngineLatency,
    compactEngineLatencyFile
} from '../../core/engineLatency.js';

/**
 * 第一步只做「数据可见」：把每次引擎耗时持久化，供 doctor 展示。
 * 关键不变量：追加写不炸、坏行跳过、按时间窗过滤、百分位正确。
 */
describe('engine latency store', () => {
    const makeEnv = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-'));
        return { env: { MYWEBSEARCH_LATENCY_PATH: path.join(dir, 'latency.jsonl') } };
    };

    it('computes percentile with linear interpolation', () => {
        expect(percentile([], 50)).toBe(0);
        expect(percentile([100], 95)).toBe(100);
        expect(percentile([10, 20, 30, 40], 50)).toBe(25);
        expect(percentile([10, 20, 30, 40], 95)).toBe(39);
    });

    it('round-trips samples and aggregates per engine', () => {
        const { env } = makeEnv();
        const now = Date.now();
        recordEngineLatency([
            { engine: 'bing', ms: 1000, ok: true, at: now },
            { engine: 'bing', ms: 3000, ok: true, at: now },
            { engine: 'bing', ms: 2000, ok: false, at: now },
            { engine: 'arxiv', ms: 25000, ok: false, at: now }
        ], env);

        const stats = readEngineLatencyStats({ env, now });
        const bing = stats.find((s) => s.engine === 'bing');
        const arxiv = stats.find((s) => s.engine === 'arxiv');

        expect(bing).toMatchObject({ samples: 3, successRate: 67, p50: 2000 });
        expect(arxiv).toMatchObject({ samples: 1, successRate: 0, p50: 25000 });
        // 按 p50 升序
        expect(stats[0]?.engine).toBe('bing');
    });

    it('drops samples outside the retention window and skips corrupt lines', () => {
        const { env } = makeEnv();
        const now = Date.now();
        fs.appendFileSync(env.MYWEBSEARCH_LATENCY_PATH as string, 'not-json\n');
        recordEngineLatency([
            { engine: 'bing', ms: 500, ok: true, at: now - 8 * 24 * 60 * 60 * 1000 },
            { engine: 'bing', ms: 700, ok: true, at: now }
        ], env);

        const stats = readEngineLatencyStats({ env, now });
        expect(stats.find((s) => s.engine === 'bing')).toMatchObject({ samples: 1, p50: 700 });
    });

    it('returns an empty list when the file does not exist', () => {
        const { env } = makeEnv();
        expect(readEngineLatencyStats({ env })).toEqual([]);
        expect(() => compactEngineLatencyFile(env)).not.toThrow();
    });

    it('ignores sub-10ms samples produced by test fakes or cache hits', () => {
        const { env } = makeEnv();
        const now = Date.now();
        recordEngineLatency([
            { engine: 'bing', ms: 0, ok: true, at: now },
            { engine: 'bing', ms: 3, ok: true, at: now },
            { engine: 'bing', ms: 1200, ok: true, at: now }
        ], env);

        // 0ms/3ms 不应入库，p50 不能被拉到 0
        expect(readEngineLatencyStats({ env, now }).find((s) => s.engine === 'bing'))
            .toMatchObject({ samples: 1, p50: 1200 });
    });
});
