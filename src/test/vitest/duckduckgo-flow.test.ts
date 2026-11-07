import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    loadWreqModule: vi.fn(),
    createWreqSession: vi.fn(),
    assertOverseasEngineUsable: vi.fn(async () => undefined)
}));

vi.mock('../../engines/bing/impersonate.js', () => ({
    loadWreqModule: mocks.loadWreqModule,
    createWreqSession: mocks.createWreqSession
}));

vi.mock('../../utils/overseasProbe.js', () => ({
    assertOverseasEngineUsable: mocks.assertOverseasEngineUsable
}));

import axios from 'axios';
import { searchDuckDuckGo } from '../../engines/duckduckgo/duckduckgo.js';

const HTML_WITH_RESULTS = `<!DOCTYPE html>
<html><body>
<div class="result">
  <a class="result__a" href="https://example.com/one">结果 1</a>
  <div class="result__snippet">描述 1</div>
  <div class="result__url">example.com</div>
</div>
</body></html>`;

describe('searchDuckDuckGo 分支流转与快速熔断测试', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.loadWreqModule.mockReset();
        mocks.createWreqSession.mockReset();
        mocks.assertOverseasEngineUsable.mockResolvedValue(undefined);
    });

    it('分支 1: wreq 遇 202 挑战立即快速失败，不跑 preload、不跑 axios HTML、不跑 CDP', async () => {
        const mockSession = {
            fetch: vi.fn().mockResolvedValue({
                status: 202,
                text: async () => '<html><body>anomaly challenge</body></html>'
            }),
            close: vi.fn().mockResolvedValue(undefined)
        };
        mocks.loadWreqModule.mockResolvedValue({});
        mocks.createWreqSession.mockResolvedValue(mockSession);

        const axiosGetSpy = vi.spyOn(axios, 'get');
        const axiosPostSpy = vi.spyOn(axios, 'post');

        await expect(searchDuckDuckGo('test query', 5)).rejects.toMatchObject({
            code: 'bot_challenge',
            status: 202,
            engine: 'duckduckgo'
        });

        expect(mockSession.fetch).toHaveBeenCalledTimes(1);
        expect(axiosGetSpy).not.toHaveBeenCalled();
        expect(axiosPostSpy).not.toHaveBeenCalled();
    });

    it('分支 2: wreq 遇 anomaly-modal 内容时立即快速失败，不跑后续请求', async () => {
        const mockSession = {
            fetch: vi.fn().mockResolvedValue({
                status: 200,
                text: async () => '<html><body><div class="anomaly-modal">Bots use DuckDuckGo too</div></body></html>'
            }),
            close: vi.fn().mockResolvedValue(undefined)
        };
        mocks.loadWreqModule.mockResolvedValue({});
        mocks.createWreqSession.mockResolvedValue(mockSession);

        const axiosGetSpy = vi.spyOn(axios, 'get');
        const axiosPostSpy = vi.spyOn(axios, 'post');

        await expect(searchDuckDuckGo('test query', 5)).rejects.toMatchObject({
            code: 'bot_challenge',
            status: 202
        });

        expect(axiosGetSpy).not.toHaveBeenCalled();
        expect(axiosPostSpy).not.toHaveBeenCalled();
    });

    it('分支 3: wreq 非 202 失败（如模块缺失），preload 遇 202 挑战立即快速失败，不跑 axios HTML', async () => {
        mocks.loadWreqModule.mockResolvedValue(null);

        const axiosGetSpy = vi.spyOn(axios, 'get').mockResolvedValue({
            status: 202,
            data: '<html><body>anomaly challenge</body></html>'
        });
        const axiosPostSpy = vi.spyOn(axios, 'post');

        await expect(searchDuckDuckGo('test query', 5)).rejects.toMatchObject({
            code: 'bot_challenge',
            status: 202
        });

        expect(axiosGetSpy).toHaveBeenCalledTimes(1);
        expect(axiosPostSpy).not.toHaveBeenCalled();
    });

    it('分支 4: wreq 与 preload 皆非 202 失败，axios HTML 遇 202 挑战直接失败', async () => {
        mocks.loadWreqModule.mockResolvedValue(null);

        // preload 遇到普通 500 错误
        vi.spyOn(axios, 'get').mockRejectedValue(new Error('Preload gateway timeout'));

        // axios HTML 遇到 202 挑战
        const axiosPostSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            status: 202,
            data: '<html><body>anomaly challenge</body></html>'
        });

        await expect(searchDuckDuckGo('test query', 5)).rejects.toMatchObject({
            code: 'bot_challenge',
            status: 202
        });

        expect(axiosPostSpy).toHaveBeenCalledTimes(1);
    });

    it('分支 5: wreq 成功 200 且有结果，直接解析返回，不跑 preload 与 axios HTML', async () => {
        const mockSession = {
            fetch: vi.fn().mockResolvedValue({
                status: 200,
                text: async () => HTML_WITH_RESULTS
            }),
            close: vi.fn().mockResolvedValue(undefined)
        };
        mocks.loadWreqModule.mockResolvedValue({});
        mocks.createWreqSession.mockResolvedValue(mockSession);

        const axiosGetSpy = vi.spyOn(axios, 'get');
        const axiosPostSpy = vi.spyOn(axios, 'post');

        const results = await searchDuckDuckGo('test query', 5);

        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('结果 1');
        expect(axiosGetSpy).not.toHaveBeenCalled();
        expect(axiosPostSpy).not.toHaveBeenCalled();
    });
});
