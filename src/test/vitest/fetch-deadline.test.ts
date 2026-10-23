import { describe, expect, it } from 'vitest';
import { combineWithDeadline } from '../../core/fetch/fetchPage.js';

/**
 * P1-13 回归：整条抓取管线必须有一个统一的 deadline。
 * 以前 cookie(15s) + 浏览器(30s) + 主请求(10s) + 回退(10s) 各自计时，最坏 ~65s，
 * 会打穿 MCP 客户端默认的工具超时。
 */
describe('combineWithDeadline', () => {
    it('aborts after the deadline even without an external signal', async () => {
        const signal = combineWithDeadline(undefined, 30);
        expect(signal.aborted).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(signal.aborted).toBe(true);
    });

    it('propagates an external abort immediately', () => {
        const parent = new AbortController();
        const signal = combineWithDeadline(parent.signal, 10_000);
        parent.abort(new Error('user cancelled'));
        expect(signal.aborted).toBe(true);
    });

    it('is already aborted when the parent signal is aborted', () => {
        const parent = new AbortController();
        parent.abort(new Error('already gone'));
        expect(combineWithDeadline(parent.signal, 10_000).aborted).toBe(true);
    });
});
