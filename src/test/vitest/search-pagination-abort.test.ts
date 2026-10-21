import { describe, expect, it } from 'vitest';
import { paginateSearch } from '../../utils/pagination.js';

/**
 * 回归保护：`paginateSearch` 在「第 2 页起失败但已有部分结果」时会把异常吞掉并返回部分结果。
 * 取消信号（AbortSignal）必须例外——否则调用方会把「被取消的截断结果」当成一次成功的搜索。
 */
describe('paginateSearch abort propagation', () => {
    it('throws when the signal is already aborted before the first page', async () => {
        const controller = new AbortController();
        controller.abort(new Error('cancelled-before-start'));

        await expect(paginateSearch({
            limit: 10,
            signal: controller.signal,
            fetchPage: async () => ['a']
        })).rejects.toThrow('cancelled-before-start');
    });

    it('propagates an abort that fires on a later page instead of returning partial results', async () => {
        const controller = new AbortController();
        let calls = 0;

        await expect(paginateSearch({
            limit: 10,
            dedupKey: (item: string) => item,
            signal: controller.signal,
            fetchPage: async () => {
                calls += 1;
                if (calls === 2) {
                    const reason = new Error('aborted-on-page-2');
                    controller.abort(reason);
                    throw reason;
                }
                return ['a', 'b'];
            }
        })).rejects.toThrow('aborted-on-page-2');
    });

    it('still keeps partial results when a non-abort error hits a later page', async () => {
        let calls = 0;

        const results = await paginateSearch({
            limit: 10,
            dedupKey: (item: string) => item,
            fetchPage: async () => {
                calls += 1;
                if (calls === 2) {
                    throw new Error('upstream exploded');
                }
                return ['a', 'b'];
            }
        });

        expect(results).toEqual(['a', 'b']);
    });
});
