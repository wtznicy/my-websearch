import { describe, it, expect } from 'vitest';
import { createConfig, engineShouldUseProxy } from '../../config.js';
import {
    buildPlaywrightProxy,
    formatChromiumProxyBypassList,
    matchesProxyBypassRule,
    shouldHostUseProxy
} from '../../utils/playwright/browserDiscovery.js';
import { buildLocalBrowserProcessArgs } from '../../utils/playwright/browserSession.js';

describe('buildPlaywrightProxy & unified proxy policy', () => {
    it('returns undefined when proxy is disabled', () => {
        const cfg = createConfig({
            PROXY_URL: 'direct'
        });
        expect(buildPlaywrightProxy(cfg)).toBeUndefined();
    });

    it('uses comma-separated bypass for Playwright API and semicolon-separated for Chromium CLI', () => {
        const cfg = createConfig({
            PROXY_URL: 'http://127.0.0.1:7897;duckduckgo,brave'
        });
        const proxy = buildPlaywrightProxy(cfg);
        expect(proxy).toBeDefined();
        expect(proxy?.bypass).toBeDefined();
        // Playwright API must use comma separator, never semicolon
        expect(proxy!.bypass).toContain(',');
        expect(proxy!.bypass).not.toContain(';');

        // Chromium CLI arguments must convert bypass list to semicolons
        const cliArgs = buildLocalBrowserProcessArgs(9222, 'C:\\Temp\\profile', [], false, cfg);
        const bypassArg = cliArgs.find((arg) => arg.startsWith('--proxy-bypass-list='));
        expect(bypassArg).toBeDefined();
        expect(bypassArg).toContain(';');
        expect(bypassArg).not.toContain(',');
        expect(formatChromiumProxyBypassList('a.com,*.a.com')).toBe('a.com;*.a.com');
    });

    it('returns loopback bypass when proxy is enabled globally without engine whitelist', () => {
        const cfg = createConfig({
            PROXY_URL: 'http://127.0.0.1:7897;all'
        });
        const proxy = buildPlaywrightProxy(cfg);
        expect(proxy).toBeDefined();
        expect(proxy?.server).toBe('http://127.0.0.1:7897');
        expect(proxy?.bypass).toContain('<local>');
        expect(proxy?.bypass).toContain('localhost');
        expect(proxy?.bypass).toContain('127.0.0.1');
        // 全局代理时不将国内引擎加入 bypass
        expect(proxy?.bypass).not.toContain('*.baidu.com');
        expect(shouldHostUseProxy('baidu.com', cfg)).toBe(true);
        expect(shouldHostUseProxy('juejin.cn', cfg)).toBe(true);
        expect(shouldHostUseProxy('localhost', cfg)).toBe(false);
    });

    it('covers both root domains and subdomains in bypass rules and rule matching', () => {
        const cfg = createConfig({
            PROXY_URL: 'http://127.0.0.1:7897;duckduckgo,brave'
        });
        const proxy = buildPlaywrightProxy(cfg);
        expect(proxy).toBeDefined();
        const rules = proxy!.bypass!.split(',');
        expect(rules).toContain('juejin.cn');
        expect(rules).toContain('*.juejin.cn');
        expect(rules).toContain('baidu.com');
        expect(rules).toContain('*.baidu.com');
        expect(rules).toContain('bing.com');
        expect(rules).toContain('*.bing.com');
        expect(rules).toContain('startpage.com');
        expect(rules).toContain('*.startpage.com');

        // Verify actual rule consumption against root and subdomain hosts
        expect(matchesProxyBypassRule('juejin.cn', 'juejin.cn')).toBe(true);
        expect(matchesProxyBypassRule('juejin.cn', '*.juejin.cn')).toBe(false);
        expect(matchesProxyBypassRule('api.juejin.cn', '*.juejin.cn')).toBe(true);

        // End-to-end host proxy decision
        expect(shouldHostUseProxy('juejin.cn', cfg)).toBe(false);
        expect(shouldHostUseProxy('api.juejin.cn', cfg)).toBe(false);
        expect(shouldHostUseProxy('bing.com', cfg)).toBe(false);
        expect(shouldHostUseProxy('www.bing.com', cfg)).toBe(false);
        expect(shouldHostUseProxy('startpage.com', cfg)).toBe(false);
        expect(shouldHostUseProxy('www.startpage.com', cfg)).toBe(false);
        expect(shouldHostUseProxy('duckduckgo.com', cfg)).toBe(true);
        expect(shouldHostUseProxy('search.brave.com', cfg)).toBe(true);
    });

    it('keeps HTTP engineShouldUseProxy and browser shouldHostUseProxy consistent when PROXY_ENGINES is set', () => {
        const cfg = createConfig({
            PROXY_URL: 'http://127.0.0.1:7897;baidu,duckduckgo'
        });
        const proxy = buildPlaywrightProxy(cfg);
        expect(proxy).toBeDefined();

        // baidu and duckduckgo are in proxyEngines -> use proxy in both HTTP and browser
        expect(engineShouldUseProxy('baidu', cfg)).toBe(true);
        expect(shouldHostUseProxy('www.baidu.com', cfg)).toBe(true);
        expect(shouldHostUseProxy('baidu.com', cfg)).toBe(true);
        expect(engineShouldUseProxy('duckduckgo', cfg)).toBe(true);
        expect(shouldHostUseProxy('duckduckgo.com', cfg)).toBe(true);

        // bing, startpage, sogou are NOT in proxyEngines -> bypass proxy in both HTTP and browser
        expect(engineShouldUseProxy('bing', cfg)).toBe(false);
        expect(shouldHostUseProxy('www.bing.com', cfg)).toBe(false);
        expect(engineShouldUseProxy('startpage', cfg)).toBe(false);
        expect(shouldHostUseProxy('www.startpage.com', cfg)).toBe(false);
        expect(engineShouldUseProxy('sogou', cfg)).toBe(false);
        expect(shouldHostUseProxy('www.sogou.com', cfg)).toBe(false);
    });

    it('handles username and password in proxy URL', () => {
        const cfg = createConfig({
            PROXY_URL: 'http://myuser:mypass@127.0.0.1:7897;all'
        });
        const proxy = buildPlaywrightProxy(cfg);
        expect(proxy).toBeDefined();
        expect(proxy?.server).toBe('http://127.0.0.1:7897');
        expect(proxy?.username).toBe('myuser');
        expect(proxy?.password).toBe('mypass');
    });
});

