import { describe, expect, it } from 'vitest';
import { ENGINE_DEFINITIONS } from '../../engines/definitions.js';
import { DEFAULT_PROXY_ENGINES } from '../../config.js';
import { OVERSEAS_ENGINE_NAMES } from '../../engines/meta.js';
import { ENGINE_REGISTRY, SUPPORTED_SEARCH_ENGINES } from '../../engines/registry.js';

/**
 * SSOT 守卫：引擎的事实定义只允许出现在 `engines/definitions.ts`。
 * 任何一份派生清单（registry / 代理名单 / 测试数组）与它不一致时，CI 立刻变红。
 */
describe('engine definitions are the single source of truth', () => {
    const definitionIds = ENGINE_DEFINITIONS.map((definition) => definition.id);

    it('has no duplicate engine ids', () => {
        expect(new Set(definitionIds).size).toBe(definitionIds.length);
    });

    it('matches the supported engine list exactly (order-insensitive)', () => {
        expect([...definitionIds].sort()).toEqual([...SUPPORTED_SEARCH_ENGINES].sort());
    });

    it('drives the overseas list and the proxy-eligible subset', () => {
        const overseasFromDefinitions = ENGINE_DEFINITIONS
            .filter((definition) => definition.region === 'overseas')
            .map((definition) => definition.id)
            .sort();
        const proxyFromDefinitions = ENGINE_DEFINITIONS
            .filter((definition) => definition.region === 'overseas' && definition.proxyInChina !== false)
            .map((definition) => definition.id)
            .sort();
        expect([...OVERSEAS_ENGINE_NAMES].sort()).toEqual(overseasFromDefinitions);
        expect([...DEFAULT_PROXY_ENGINES].sort()).toEqual(proxyFromDefinitions);
    });

    it('keeps API-reachable engines out of the default proxy list', () => {
        for (const engine of ['github', 'stackoverflow', 'hackernews', 'arxiv']) {
            expect(ENGINE_DEFINITIONS.find((entry) => entry.id === engine)?.proxyInChina).toBe(false);
            expect(DEFAULT_PROXY_ENGINES).not.toContain(engine);
        }
    });

    it('has a registry descriptor for every definition', () => {
        for (const definition of ENGINE_DEFINITIONS) {
            const descriptor = ENGINE_REGISTRY.find((entry) => entry.name === definition.id);
            expect(descriptor, `missing registry descriptor for ${definition.id}`).toBeDefined();
        }
    });

    it('does not let foreign engines sneak into the domestic general pool', () => {
        const domesticGeneral = ENGINE_DEFINITIONS
            .filter((definition) => definition.region === 'domestic' && definition.category === 'general')
            .map((definition) => definition.id)
            .sort();
        // 中文主路由只允许国内通用引擎（垂类/海外引擎由级联补位）
        expect(domesticGeneral).toEqual(['baidu', 'bing', 'sogou']);
    });
});
