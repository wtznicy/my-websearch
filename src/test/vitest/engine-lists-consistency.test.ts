import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXY_ENGINES } from '../../config.js';
import { OVERSEAS_ENGINE_NAMES } from '../../engines/meta.js';
import { SUPPORTED_SEARCH_ENGINES } from '../../engines/registry.js';

/**
 * P1-11 回归：引擎清单此前散落三处且已分叉（config 的默认代理列表漏了 code，
 * 导致配置代理后 code 引擎仍走直连）。现在以 engines/meta 为单一事实源，
 * 这条测试保证「再有人手工加引擎却忘记同步清单」时 CI 立刻变红。
 */
describe('engine list consistency', () => {
    it('default proxy engines are derived from the overseas metadata list', () => {
        expect([...DEFAULT_PROXY_ENGINES].sort()).toEqual([...OVERSEAS_ENGINE_NAMES].sort());
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
});
