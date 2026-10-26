import { describe, expect, it } from 'vitest';
import { parseProxyConfig, DEFAULT_PROXY_ENGINES } from '../../config.js';
import { PROXY_REQUIRED_ENGINE_NAMES } from '../../engines/meta.js';

describe('proxy engine configuration', () => {
    it('keeps yahoo and bing-news in the default list', () => {
        expect(DEFAULT_PROXY_ENGINES).toContain('yahoo');
        expect(DEFAULT_PROXY_ENGINES).toContain('bing-news');
    });

    it('auto-adds proxy-required engines to an explicit legacy whitelist', () => {
        const parsed = parseProxyConfig('http://127.0.0.1:7897', undefined, 'duckduckgo,brave');
        for (const engine of PROXY_REQUIRED_ENGINE_NAMES) {
            expect(parsed.proxyEngines).toContain(engine);
        }
        expect(parsed.proxyEngines).toContain('duckduckgo');
    });

    it('keeps an empty list as "all engines use proxy"', () => {
        const parsed = parseProxyConfig('http://127.0.0.1:7897', undefined, '');
        expect(parsed.proxyEngines).toEqual([]);
    });
});
