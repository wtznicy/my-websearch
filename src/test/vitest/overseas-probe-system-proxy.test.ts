import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    detect: vi.fn(async (): Promise<string | null> => null)
}));

vi.mock('../../utils/systemProxy.js', () => ({
    detectSystemProxy: mocks.detect,
    getDetectedSystemProxy: () => null
}));

import axios from 'axios';
import { assertOverseasEngineUsable, __setOverseasReachableForTests } from '../../utils/overseasProbe.js';

/**
 * 回归：系统代理存在时不应被 3s 可达性探测误杀。
 * 之前测到代理但探测超时 → 抛 overseas_unreachable（文案还写成"通过代理也不可达"）。
 */
describe('assertOverseasEngineUsable with a system proxy', () => {
    beforeEach(() => {
        __setOverseasReachableForTests(null);
        vi.restoreAllMocks();
        mocks.detect.mockReset();
    });

    it('does not probe or block when a system proxy is detected', async () => {
        mocks.detect.mockResolvedValue('http://127.0.0.1:7897');
        const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('probe timeout'));

        await expect(assertOverseasEngineUsable('duckduckgo')).resolves.toBeUndefined();
        // 直接放行给真实请求判断，不应再发起探测
        expect(get).not.toHaveBeenCalled();
    });

    it('still fails fast when no proxy exists and the direct probe fails', async () => {
        mocks.detect.mockResolvedValue(null);
        vi.spyOn(axios, 'get').mockRejectedValue(new Error('ECONNRESET'));

        await expect(assertOverseasEngineUsable('duckduckgo')).rejects.toMatchObject({
            code: 'overseas_unreachable'
        });
    });

    it('passes when the direct probe succeeds without a proxy', async () => {
        mocks.detect.mockResolvedValue(null);
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: '' });

        await expect(assertOverseasEngineUsable('duckduckgo')).resolves.toBeUndefined();
    });
});
