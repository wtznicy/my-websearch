import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * SSRF 防护回归用例。
 *
 * 背景（2026-09-25 实测）：`assertPublicHttpUrlResolved` 在 `config.useProxy === true` 时
 * 直接 return，跳过整段 DNS→IP 校验；用一个解析到回环的域名（`127.0.0.1.nip.io`）配
 * `USE_PROXY=true` 可读出本机服务内容（靶机实验复现），而不配代理时同 URL 会被拦。
 */
const ENV_KEYS = ['USE_PROXY', 'PROXY_URL', 'FAKE_IP_CIDRS'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;

function setEnv(env: Record<string, string | undefined>): void {
    for (const key of ENV_KEYS) {
        const value = key in env ? env[key] : originalEnv[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

/** 按给定的 DNS 答案加载一份全新的 urlSafety 模块（config 在 import 时读 env） */
async function loadUrlSafety(dnsAnswers: Record<string, string[]> = {}) {
    vi.resetModules();
    const mod = await import('../../utils/urlSafety.js');
    mod.__setDnsLookupForTests(async (hostname: string) => {
        const addresses = dnsAnswers[hostname] ?? ['93.184.216.34'];
        return addresses.map((address) => ({ address }));
    });
    return mod;
}

describe('isRebindingStyleHostname', () => {
    it('应识别把 IP 编码进域名的通配 DNS 服务（含子域）', async () => {
        const { isRebindingStyleHostname } = await loadUrlSafety();

        expect(isRebindingStyleHostname('127.0.0.1.nip.io')).toBe(true);
        expect(isRebindingStyleHostname('10.0.0.1.sslip.io')).toBe(true);
        expect(isRebindingStyleHostname('localtest.me')).toBe(true);
        expect(isRebindingStyleHostname('Foo.Localtest.Me')).toBe(true);
        expect(isRebindingStyleHostname('xip.io')).toBe(true);
        expect(isRebindingStyleHostname('example.com')).toBe(false);
        expect(isRebindingStyleHostname('notnip.io.example.com')).toBe(false);
    });

    it('assertPublicHttpUrl 应拒绝重绑定域名（无需 DNS）', async () => {
        const { assertPublicHttpUrl } = await loadUrlSafety();

        expect(() => assertPublicHttpUrl('http://127.0.0.1.nip.io:18080/secret')).toThrow(/wildcard DNS|rebinding/i);
        expect(() => assertPublicHttpUrl('http://example.com/')).not.toThrow();
    });
});

describe('assertPublicHttpUrlResolved 代理模式下的私网判定', () => {
    afterEach(() => {
        setEnv({});
        vi.resetModules();
    });

    it('USE_PROXY=true 时解析到回环的域名仍应被拦截（原漏洞的回归用例）', async () => {
        setEnv({ USE_PROXY: 'true', PROXY_URL: 'http://127.0.0.1:7890', FAKE_IP_CIDRS: '' });
        const { assertPublicHttpUrlResolved } = await loadUrlSafety({ 'internal.example.com': ['127.0.0.1'] });

        await expect(assertPublicHttpUrlResolved('http://internal.example.com/secret')).rejects.toThrow(/private or local network/i);
    });

    it('USE_PROXY=true 时解析到内网段（10.x / 169.254）同样拦截', async () => {
        setEnv({ USE_PROXY: 'true', PROXY_URL: 'http://127.0.0.1:7890', FAKE_IP_CIDRS: '' });
        const { assertPublicHttpUrlResolved } = await loadUrlSafety({
            'a.internal.example.com': ['10.1.2.3'],
            'b.internal.example.com': ['169.254.169.254']
        });

        await expect(assertPublicHttpUrlResolved('http://a.internal.example.com/')).rejects.toThrow(/private or local network/i);
        await expect(assertPublicHttpUrlResolved('http://b.internal.example.com/')).rejects.toThrow(/private or local network/i);
    });

    it('fake-ip（Clash TUN 伪造段）在代理模式下按配置放行，不误杀 TUN 用户', async () => {
        setEnv({ USE_PROXY: 'true', PROXY_URL: 'http://127.0.0.1:7890' });
        const { assertPublicHttpUrlResolved } = await loadUrlSafety({ 'raw.githubusercontent.com': ['198.18.0.41'] });

        await expect(assertPublicHttpUrlResolved('https://raw.githubusercontent.com/x/y.md')).resolves.toBeUndefined();
    });

    it('0.0.0.0/8（本地 DNS 污染）在代理模式下交给代理处理，不算安全拦截', async () => {
        setEnv({ USE_PROXY: 'true', PROXY_URL: 'http://127.0.0.1:7890' });
        const { assertPublicHttpUrlResolved } = await loadUrlSafety({ 'polluted.example.com': ['0.0.0.0'] });

        await expect(assertPublicHttpUrlResolved('https://polluted.example.com/')).resolves.toBeUndefined();
    });

    it('同样解析到 0.0.0.0，未开代理时应报黑洞地址（保持原行为）', async () => {
        setEnv({ USE_PROXY: undefined });
        const { assertPublicHttpUrlResolved } = await loadUrlSafety({ 'polluted.example.com': ['0.0.0.0'] });

        await expect(assertPublicHttpUrlResolved('https://polluted.example.com/')).rejects.toThrow(/blackhole/i);
    });

    it('公网地址两种模式下都放行', async () => {
        setEnv({ USE_PROXY: 'true', PROXY_URL: 'http://127.0.0.1:7890' });
        const proxied = await loadUrlSafety({ 'example.com': ['93.184.216.34'] });
        await expect(proxied.assertPublicHttpUrlResolved('https://example.com/')).resolves.toBeUndefined();

        setEnv({ USE_PROXY: undefined });
        const direct = await loadUrlSafety({ 'example.com': ['93.184.216.34'] });
        await expect(direct.assertPublicHttpUrlResolved('https://example.com/')).resolves.toBeUndefined();
    });
});
