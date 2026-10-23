import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXY_ENGINES } from '../../config.js';
import { OVERSEAS_ENGINE_NAMES, PROXY_ENGINE_NAMES } from '../../engines/meta.js';
import { SUPPORTED_SEARCH_ENGINES } from '../../engines/registry.js';

/**
 * P1-11 回归：引擎清单此前散落三处且已分叉（config 的默认代理列表漏了 code）。
 * 现在默认代理名单 = 海外引擎中 proxyInChina !== false 的子集：
 * GitHub / StackExchange / HN Algolia / arXiv export 实测直连可达，默认不走代理。
 */
describe('engine list consistency', () => {
    it('default proxy engines are derived from the proxy-eligible metadata list', () => {
        expect([...DEFAULT_PROXY_ENGINES].sort()).toEqual([...PROXY_ENGINE_NAMES].sort());
    });

    it('every overseas engine is a supported search engine', () => {
        for (const engine of OVERSEAS_ENGINE_NAMES) {
            expect(SUPPORTED_SEARCH_ENGINES).toContain(engine);
        }
    });

    it('includes code, the engine that previously drifted out of the proxy list', () => {
        expect(DEFAULT_PROXY_ENGINES).toContain('code');
        expect(SUPPORTED_SEARCH_ENGINES).toContain('code');
    });

    it('excludes direct-reachable API engines from the default proxy list', () => {
        for (const engine of ['github', 'stackoverflow', 'hackernews', 'arxiv']) {
            expect(OVERSEAS_ENGINE_NAMES).toContain(engine);
            expect(DEFAULT_PROXY_ENGINES).not.toContain(engine);
        }
    });
});
