import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * wreq 会话代理解析口径（resolveWreqProxyUrl）。
 *
 * 背景：wreq 会话此前不传 proxy，USE_PROXY=true 的非 TUN 用户（显式 HTTP 代理）会绕过代理直连而超时。
 * 口径只覆盖**显式代理**（USE_PROXY + PROXY_ENGINES 白名单），不接系统代理兜底——
 * 系统代理在 axios 路径靠"直连优先、失败再走代理"保护，而会话级 proxy 是一绑到底的
 * （陈旧系统代理项会让 TUN 下本可直连的请求失败）。
 */
describe('resolveWreqProxyUrl', () => {
    const originalEnv = {
        USE_PROXY: process.env.USE_PROXY,
        PROXY_URL: process.env.PROXY_URL,
        PROXY_ENGINES: process.env.PROXY_ENGINES
    };

    afterEach(() => {
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        vi.resetModules();
    });

    async function loadResolver() {
        vi.resetModules();
        return import('../../engines/bing/impersonate.js');
    }

    it('USE_PROXY=true 时白名单内引擎解析出代理 URL', async () => {
        process.env.USE_PROXY = 'true';
        process.env.PROXY_URL = 'http://127.0.0.1:34567';
        process.env.PROXY_ENGINES = 'brave,duckduckgo';

        const { resolveWreqProxyUrl } = await loadResolver();

        expect(resolveWreqProxyUrl('brave')).toBe('http://127.0.0.1:34567');
        expect(resolveWreqProxyUrl('duckduckgo')).toBe('http://127.0.0.1:34567');
        // 白名单外（国内引擎）保持直连
        expect(resolveWreqProxyUrl('baidu')).toBeUndefined();
        // 未指定引擎（如原生模块可用性探测）不带代理
        expect(resolveWreqProxyUrl(undefined)).toBeUndefined();
    });

    it('USE_PROXY=true 且白名单为空时全部引擎走代理（兼容旧全局行为）', async () => {
        process.env.USE_PROXY = 'true';
        process.env.PROXY_URL = 'http://127.0.0.1:34567';
        process.env.PROXY_ENGINES = '';

        const { resolveWreqProxyUrl } = await loadResolver();

        expect(resolveWreqProxyUrl('baidu')).toBe('http://127.0.0.1:34567');
    });

    it('未设 USE_PROXY 时不带代理（海外引擎的系统代理由 axios 回退路径处理）', async () => {
        delete process.env.USE_PROXY;
        process.env.PROXY_URL = 'http://127.0.0.1:34567';
        process.env.PROXY_ENGINES = 'brave';

        const { resolveWreqProxyUrl } = await loadResolver();

        expect(resolveWreqProxyUrl('brave')).toBeUndefined();
    });
});
