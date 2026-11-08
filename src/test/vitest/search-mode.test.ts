import { describe, it, expect } from 'vitest';
import {
    parseSearchModeConfig,
    createConfig,
    getEngineSearchMode,
    engineShouldUsePlaywrightFallback,
    parseProxyConfig,
    DEFAULT_PROXY_URL,
    DEFAULT_PROXY_ENGINES
} from '../../config.js';

describe('SEARCH_MODE and Playwright Fallback Unification (Plan A)', () => {
    describe('parseSearchModeConfig', () => {
        it('defaults to auto with all known playwright engines', () => {
            const parsed = parseSearchModeConfig(undefined);
            expect(parsed.searchMode).toBe('auto');
            expect(parsed.playwrightEngines).toEqual(['bing', 'brave']);

            const parsedAuto = parseSearchModeConfig('auto');
            expect(parsedAuto.searchMode).toBe('auto');
            expect(parsedAuto.playwrightEngines).toEqual(['bing', 'brave']);
        });

        it('disables playwright for all engines when request, none, or false', () => {
            const parsedReq = parseSearchModeConfig('request');
            expect(parsedReq.searchMode).toBe('request');
            expect(parsedReq.playwrightEngines).toEqual([]);

            const parsedNone = parseSearchModeConfig('none');
            expect(parsedNone.searchMode).toBe('request');
            expect(parsedNone.playwrightEngines).toEqual([]);

            const parsedFalse = parseSearchModeConfig('false');
            expect(parsedFalse.searchMode).toBe('request');
            expect(parsedFalse.playwrightEngines).toEqual([]);
        });

        it('forces playwright for all supported engines when playwright or all', () => {
            const parsedPw = parseSearchModeConfig('playwright');
            expect(parsedPw.searchMode).toBe('playwright');
            expect(parsedPw.playwrightEngines).toEqual(['bing', 'brave']);

            const parsedAll = parseSearchModeConfig('all');
            expect(parsedAll.searchMode).toBe('playwright');
            expect(parsedAll.playwrightEngines).toEqual(['bing', 'brave']);
        });

        it('supports single engine specification in SEARCH_MODE', () => {
            const parsedBing = parseSearchModeConfig('bing');
            expect(parsedBing.searchMode).toBe('request');
            expect(parsedBing.engineSearchModes['bing']).toBe('auto');
            expect(parsedBing.playwrightEngines).toEqual(['bing']);

            const parsedBrave = parseSearchModeConfig('brave');
            expect(parsedBrave.searchMode).toBe('request');
            expect(parsedBrave.engineSearchModes['brave']).toBe('auto');
            expect(parsedBrave.playwrightEngines).toEqual(['brave']);
        });

        it('supports comma-separated engine multi-select in SEARCH_MODE', () => {
            const parsedBoth = parseSearchModeConfig('bing,brave');
            expect(parsedBoth.searchMode).toBe('request');
            expect(parsedBoth.engineSearchModes['bing']).toBe('auto');
            expect(parsedBoth.engineSearchModes['brave']).toBe('auto');
            expect(parsedBoth.playwrightEngines).toEqual(['bing', 'brave']);
        });

        it('supports one mode with multiple engines: e.g. playwright:bing,brave', () => {
            const parsed = parseSearchModeConfig('playwright:bing,brave');
            expect(parsed.searchMode).toBe('request');
            expect(parsed.engineSearchModes['bing']).toBe('playwright');
            expect(parsed.engineSearchModes['brave']).toBe('playwright');
            expect(parsed.playwrightEngines).toEqual(['bing', 'brave']);

            const parsedAutoMulti = parseSearchModeConfig('auto:bing,brave');
            expect(parsedAutoMulti.searchMode).toBe('request');
            expect(parsedAutoMulti.engineSearchModes['bing']).toBe('auto');
            expect(parsedAutoMulti.engineSearchModes['brave']).toBe('auto');
            expect(parsedAutoMulti.playwrightEngines).toEqual(['bing', 'brave']);
        });

        it('supports multiple modes configuration using semicolons: e.g. playwright:bing;auto:brave', () => {
            const parsed = parseSearchModeConfig('playwright:bing;auto:brave');
            expect(parsed.searchMode).toBe('request');
            expect(parsed.engineSearchModes['bing']).toBe('playwright');
            expect(parsed.engineSearchModes['brave']).toBe('auto');
            expect(parsed.playwrightEngines).toEqual(['bing', 'brave']);
        });

        it('supports multiple modes configuration using commas: e.g. playwright:bing,auto:brave', () => {
            const parsed = parseSearchModeConfig('playwright:bing,auto:brave');
            expect(parsed.searchMode).toBe('request');
            expect(parsed.engineSearchModes['bing']).toBe('playwright');
            expect(parsed.engineSearchModes['brave']).toBe('auto');
            expect(parsed.playwrightEngines).toEqual(['bing', 'brave']);
        });

        it('supports global default mode with specific engine override: e.g. auto;request:brave', () => {
            const parsed = parseSearchModeConfig('auto;request:brave');
            expect(parsed.searchMode).toBe('auto');
            expect(parsed.engineSearchModes['brave']).toBe('request');
            expect(parsed.playwrightEngines).toEqual(['bing']);
        });

        it('supports global default mode with playwright engine override: e.g. request;playwright:bing', () => {
            const parsed = parseSearchModeConfig('request;playwright:bing');
            expect(parsed.searchMode).toBe('request');
            expect(parsed.engineSearchModes['bing']).toBe('playwright');
            expect(parsed.playwrightEngines).toEqual(['bing']);
        });

    });

    describe('createConfig, getEngineSearchMode and AppConfig integration', () => {
        it('derives boolean flags correctly when SEARCH_MODE=bing', () => {
            const cfg = createConfig({ SEARCH_MODE: 'bing' }, { quiet: true });
            expect(cfg.searchMode).toBe('request');
            expect(cfg.playwrightEngines).toEqual(['bing']);
            expect(getEngineSearchMode('bing', cfg)).toBe('auto');
            expect(getEngineSearchMode('brave', cfg)).toBe('request');
            expect(engineShouldUsePlaywrightFallback('bing', cfg)).toBe(true);
            expect(engineShouldUsePlaywrightFallback('brave', cfg)).toBe(false);
        });

        it('derives boolean flags correctly when SEARCH_MODE=request', () => {
            const cfg = createConfig({ SEARCH_MODE: 'request' }, { quiet: true });
            expect(cfg.searchMode).toBe('request');
            expect(cfg.playwrightEngines).toEqual([]);
            expect(getEngineSearchMode('bing', cfg)).toBe('request');
            expect(getEngineSearchMode('brave', cfg)).toBe('request');
            expect(engineShouldUsePlaywrightFallback('bing', cfg)).toBe(false);
            expect(engineShouldUsePlaywrightFallback('brave', cfg)).toBe(false);
        });

        it('supports hybrid multiple modes: SEARCH_MODE=playwright:bing;auto:brave', () => {
            const cfg = createConfig({ SEARCH_MODE: 'playwright:bing;auto:brave' }, { quiet: true });
            expect(getEngineSearchMode('bing', cfg)).toBe('playwright');
            expect(getEngineSearchMode('brave', cfg)).toBe('auto');
            expect(cfg.playwrightEngines).toEqual(['bing', 'brave']);
            expect(engineShouldUsePlaywrightFallback('bing', cfg)).toBe(true);
            expect(engineShouldUsePlaywrightFallback('brave', cfg)).toBe(true);
        });

        it('supports global default with override: SEARCH_MODE=auto;request:brave', () => {
            const cfg = createConfig({ SEARCH_MODE: 'auto;request:brave' }, { quiet: true });
            expect(cfg.searchMode).toBe('auto');
            expect(getEngineSearchMode('bing', cfg)).toBe('auto');
            expect(getEngineSearchMode('brave', cfg)).toBe('request');
            expect(cfg.playwrightEngines).toEqual(['bing']);
            expect(engineShouldUsePlaywrightFallback('bing', cfg)).toBe(true);
            expect(engineShouldUsePlaywrightFallback('brave', cfg)).toBe(false);
        });


        it('configures BING_BASE_URL with default and custom values', () => {
            const defaultCfg = createConfig({}, { quiet: true });
            expect(defaultCfg.bingBaseUrl).toBe('https://cn.bing.com/search');

            const customCfg = createConfig({ BING_BASE_URL: 'https://www.bing.com/search/' }, { quiet: true });
            expect(customCfg.bingBaseUrl).toBe('https://www.bing.com/search');

            const legacyCfg = createConfig({ OPEN_WEBSEARCH_BING_HOST: 'https://intl.bing.com/search/' }, { quiet: true });
            expect(legacyCfg.bingBaseUrl).toBe('https://intl.bing.com/search');

            const bothCfg = createConfig({
                BING_BASE_URL: 'https://primary.bing.com/search',
                OPEN_WEBSEARCH_BING_HOST: 'https://legacy.bing.com/search'
            }, { quiet: true });
            expect(bothCfg.bingBaseUrl).toBe('https://primary.bing.com/search');
        });
    });

    describe('parseProxyConfig and PROXY_URL consolidation', () => {
        it('defaults to disabled proxy with default URL 7897 and default overseas engines', () => {
            const parsed = parseProxyConfig(undefined);
            expect(parsed.useProxy).toBe(false);
            expect(parsed.proxyUrl).toBe(DEFAULT_PROXY_URL);
            expect(parsed.proxyUrl).toBe('http://127.0.0.1:7897');
            expect(parsed.proxyEngines).toEqual(DEFAULT_PROXY_ENGINES);
        });

        it('enables default proxy when passing empty string ("传空代表默认值")', () => {
            const parsed = parseProxyConfig('');
            expect(parsed.useProxy).toBe(true);
            expect(parsed.proxyUrl).toBe('http://127.0.0.1:7897');
            expect(parsed.proxyEngines).toEqual(DEFAULT_PROXY_ENGINES);

            const parsedSpace = parseProxyConfig('   ');
            expect(parsedSpace.useProxy).toBe(true);
            expect(parsedSpace.proxyUrl).toBe('http://127.0.0.1:7897');
        });

        it('enables default proxy when passing true or 1', () => {
            expect(parseProxyConfig('true').useProxy).toBe(true);
            expect(parseProxyConfig('true').proxyUrl).toBe('http://127.0.0.1:7897');
            expect(parseProxyConfig('1').useProxy).toBe(true);
            expect(parseProxyConfig('default').useProxy).toBe(true);
        });

        it('accepts custom URL with protocol or without protocol', () => {
            const parsed = parseProxyConfig('http://127.0.0.1:10809');
            expect(parsed.useProxy).toBe(true);
            expect(parsed.proxyUrl).toBe('http://127.0.0.1:10809');
            expect(parsed.proxyEngines).toEqual(DEFAULT_PROXY_ENGINES);

            const parsedNoProto = parseProxyConfig('127.0.0.1:10809/');
            expect(parsedNoProto.useProxy).toBe(true);
            expect(parsedNoProto.proxyUrl).toBe('http://127.0.0.1:10809');
        });

        it('supports specifying engines via semicolon, hash, or query parameter', () => {
            const parsedSemi = parseProxyConfig('http://127.0.0.1:7897;duckduckgo,brave');
            expect(parsedSemi.useProxy).toBe(true);
            expect(parsedSemi.proxyUrl).toBe('http://127.0.0.1:7897');
            expect(parsedSemi.proxyEngines).toEqual(['duckduckgo', 'brave', 'bing-news', 'yahoo']);

            const parsedAll = parseProxyConfig('http://127.0.0.1:7897;all');
            expect(parsedAll.useProxy).toBe(true);
            expect(parsedAll.proxyEngines).toEqual([]);

            const parsedHash = parseProxyConfig('http://127.0.0.1:7897#startpage,exa');
            expect(parsedHash.useProxy).toBe(true);
            expect(parsedHash.proxyEngines).toEqual(['startpage', 'exa', 'bing-news', 'yahoo']);
        });

        it('supports disabling proxy with false, none, off, 0, direct', () => {
            expect(parseProxyConfig('false').useProxy).toBe(false);
            expect(parseProxyConfig('none').useProxy).toBe(false);
            expect(parseProxyConfig('off').useProxy).toBe(false);
            expect(parseProxyConfig('0').useProxy).toBe(false);
            expect(parseProxyConfig('direct').useProxy).toBe(false);
        });

        it('integrates seamlessly in createConfig with backward compatibility', () => {
            // PROXY_URL=""
            const emptyCfg = createConfig({ PROXY_URL: '' }, { quiet: true });
            expect(emptyCfg.useProxy).toBe(true);
            expect(emptyCfg.proxyUrl).toBe('http://127.0.0.1:7897');
            expect(emptyCfg.proxyEngines).toEqual(DEFAULT_PROXY_ENGINES);

            // Legacy USE_PROXY=true with no PROXY_URL
            const legacyTrueCfg = createConfig({ USE_PROXY: 'true' }, { quiet: true });
            expect(legacyTrueCfg.useProxy).toBe(true);
            expect(legacyTrueCfg.proxyUrl).toBe('http://127.0.0.1:7897');

            // Legacy USE_PROXY=false
            const legacyFalseCfg = createConfig({ USE_PROXY: 'false', PROXY_URL: 'http://127.0.0.1:7897' }, { quiet: true });
            expect(legacyFalseCfg.useProxy).toBe(false);

            // Legacy PROXY_ENGINES override
            const legacyEnginesCfg = createConfig({
                PROXY_URL: 'http://127.0.0.1:7897',
                PROXY_ENGINES: 'bing,duckduckgo'
            }, { quiet: true });
            expect(legacyEnginesCfg.useProxy).toBe(true);
            expect(legacyEnginesCfg.proxyEngines).toEqual(['bing', 'duckduckgo', 'bing-news', 'yahoo']);
        });
    });
});


