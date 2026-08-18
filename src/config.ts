// src/config.ts
import ipaddr from 'ipaddr.js';

export interface AppConfig {
    // Search engine configuration
    defaultSearchEngine: 'bing' | 'duckduckgo' | 'exa' | 'brave' | 'baidu' | 'csdn' | 'juejin' | 'startpage' | 'sogou';
    // List of allowed search engines (if empty, all engines are available)
    allowedSearchEngines: string[];
    // Search mode: request only, auto request then fallback, or force Playwright
    // Currently only affects Bing.
    searchMode: 'request' | 'auto' | 'playwright';
    // 全局并发搜索限制：同时进行的搜索请求数上限（0 = 不限制）。
    // CLI 一次性调用不受此限制，仅 daemon 模式下多客户端并发时生效。
    maxConcurrentSearches: number;
    // When searchMode=auto and Bing's request mode hits an anti-bot page, should we
    // fall back to launching a Playwright browser (slow, ~400MB, hidden window)?
    // Set BING_PLAYWRIGHT_FALLBACK=false to instead surface the error so the search
    // service can cascade to lighter engines (duckduckgo/brave) via minResults.
    bingPlaywrightFallback: boolean;
    // Bing HTTP 模式使用的浏览器指纹目标（curl-cffi-node impersonate 参数，
    // 如 chrome131 / chrome124 / chrome116）。Chrome 指纹保鲜期以年计，
    // 被反爬标记时才需要切到更新的目标。
    bingImpersonateTarget: string;
    // startpage 的 Playwright 兜底开关（hidden-headed 预热 Anubis 挑战）。
    // false 时不启动浏览器，HTTP 被反爬直接报错（可配合 minResults 级联换引擎）。
    startpagePlaywrightFallback: boolean;
    // Proxy configuration
    proxyUrl?: string;
    useProxy: boolean;
    // Engines that route through the proxy when USE_PROXY=true (comma-separated in PROXY_ENGINES).
    // Empty list = all engines use proxy (legacy global-proxy behavior).
    proxyEngines: string[];
    fakeIpCidrs: string[];
    fetchWebAllowInsecureTls: boolean;
    // Playwright configuration
    playwrightPackage: 'auto' | 'playwright' | 'playwright-core';
    playwrightModulePath?: string;
    playwrightExecutablePath?: string;
    playwrightWsEndpoint?: string;
    playwrightCdpEndpoint?: string;
    playwrightHeadless: boolean;
    playwrightNavigationTimeoutMs: number;
    // CORS configuration
    enableCors: boolean;
    corsOrigin: string;
    // Server configuration (determined by MODE env var: 'both', 'http', or 'stdio')
    enableHttpServer: boolean;
}

function readOptionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

// Read from environment variables or use defaults
export const config: AppConfig = {
    // Search engine configuration
    defaultSearchEngine: (process.env.DEFAULT_SEARCH_ENGINE as AppConfig['defaultSearchEngine']) || 'bing',
    // Parse comma-separated list of allowed search engines
    allowedSearchEngines: process.env.ALLOWED_SEARCH_ENGINES ?
        process.env.ALLOWED_SEARCH_ENGINES.split(',').map(e => e.trim()) :
        [],
    searchMode: (process.env.SEARCH_MODE as AppConfig['searchMode']) || 'auto',
    maxConcurrentSearches: Number(process.env.MAX_CONCURRENT_SEARCHES || '0'),
    bingPlaywrightFallback: process.env.BING_PLAYWRIGHT_FALLBACK !== 'false',
    bingImpersonateTarget: readOptionalEnv('BING_IMPERSONATE_TARGET') || 'chrome131',
    startpagePlaywrightFallback: process.env.STARTPAGE_PLAYWRIGHT_FALLBACK !== 'false',
    // Proxy configuration
    proxyUrl: process.env.PROXY_URL || 'http://127.0.0.1:7890',
    useProxy: process.env.USE_PROXY === 'true',
    proxyEngines: process.env.PROXY_ENGINES ?
        process.env.PROXY_ENGINES.split(',').map(e => e.trim()).filter(Boolean) :
        [],
    fakeIpCidrs: process.env.FAKE_IP_CIDRS ?
        process.env.FAKE_IP_CIDRS.split(',').map(cidr => cidr.trim()).filter(Boolean) :
        [],
    fetchWebAllowInsecureTls: process.env.FETCH_WEB_INSECURE_TLS === 'true',
    playwrightPackage: (process.env.PLAYWRIGHT_PACKAGE as AppConfig['playwrightPackage']) || 'auto',
    playwrightModulePath: readOptionalEnv('PLAYWRIGHT_MODULE_PATH'),
    playwrightExecutablePath: readOptionalEnv('PLAYWRIGHT_EXECUTABLE_PATH'),
    playwrightWsEndpoint: readOptionalEnv('PLAYWRIGHT_WS_ENDPOINT'),
    playwrightCdpEndpoint: readOptionalEnv('PLAYWRIGHT_CDP_ENDPOINT'),
    playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    playwrightNavigationTimeoutMs: Number(process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || 20000),
    // CORS configuration
    enableCors: process.env.ENABLE_CORS === 'true',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    // Server configuration - determined by MODE environment variable
    // Modes: 'both' (default), 'http', 'stdio'
    enableHttpServer: process.env.MODE ? ['both', 'http'].includes(process.env.MODE) : true
};

// Valid search engines list
const validSearchEngines = ['bing', 'duckduckgo', 'exa', 'brave', 'baidu', 'csdn', 'juejin', 'startpage', 'sogou'];
const validSearchModes = ['request', 'auto', 'playwright'];
const validPlaywrightPackages = ['auto', 'playwright', 'playwright-core'];
const quietStartupLogs = process.env.OPEN_WEBSEARCH_QUIET_STARTUP === 'true'
    || (process.env.LOG_LEVEL ?? '').toLowerCase() === 'quiet';

// Validate default search engine
if (!validSearchEngines.includes(config.defaultSearchEngine)) {
    console.warn(`Invalid DEFAULT_SEARCH_ENGINE: "${config.defaultSearchEngine}", falling back to "bing"`);
    config.defaultSearchEngine = 'bing';
}

if (!validSearchModes.includes(config.searchMode)) {
    console.warn(`Invalid SEARCH_MODE: "${config.searchMode}", falling back to "auto"`);
    config.searchMode = 'auto';
}

if (!validPlaywrightPackages.includes(config.playwrightPackage)) {
    console.warn(`Invalid PLAYWRIGHT_PACKAGE: "${config.playwrightPackage}", falling back to "auto"`);
    config.playwrightPackage = 'auto';
}

if (config.fakeIpCidrs.length > 0) {
    const invalidFakeIpCidrs = config.fakeIpCidrs.filter((cidr) => {
        try {
            ipaddr.parseCIDR(cidr);
            return false;
        } catch {
            return true;
        }
    });
    if (invalidFakeIpCidrs.length > 0) {
        console.warn(`Invalid FAKE_IP_CIDRS entries will be ignored: ${invalidFakeIpCidrs.join(', ')}`);
    }
    config.fakeIpCidrs = config.fakeIpCidrs.filter((cidr) => {
        try {
            ipaddr.parseCIDR(cidr);
            return true;
        } catch {
            return false;
        }
    });
}

if (!Number.isFinite(config.playwrightNavigationTimeoutMs) || config.playwrightNavigationTimeoutMs <= 0) {
    console.warn(`Invalid PLAYWRIGHT_NAVIGATION_TIMEOUT_MS: "${process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS}", falling back to 20000`);
    config.playwrightNavigationTimeoutMs = 20000;
}

if (config.playwrightWsEndpoint && config.playwrightCdpEndpoint) {
    console.warn('Both PLAYWRIGHT_WS_ENDPOINT and PLAYWRIGHT_CDP_ENDPOINT are set, PLAYWRIGHT_WS_ENDPOINT will take precedence');
}

if ((config.playwrightWsEndpoint || config.playwrightCdpEndpoint) && config.playwrightExecutablePath) {
    console.warn('PLAYWRIGHT_EXECUTABLE_PATH is ignored when connecting to a remote browser endpoint');
}

// Validate allowed search engines
if (config.allowedSearchEngines.length > 0) {
    // Filter out invalid engines
    const invalidEngines = config.allowedSearchEngines.filter(engine => !validSearchEngines.includes(engine));
    if (invalidEngines.length > 0) {
        console.warn(`Invalid search engines detected and will be ignored: ${invalidEngines.join(', ')}`);
    }
    config.allowedSearchEngines = config.allowedSearchEngines.filter(engine => validSearchEngines.includes(engine));

    // If all engines were invalid, don't restrict (allow all engines)
    if (config.allowedSearchEngines.length === 0) {
        console.warn(`No valid search engines specified in the allowed list, all engines will be available`);
    }
    // Check if default engine is in the allowed list
    else if (!config.allowedSearchEngines.includes(config.defaultSearchEngine)) {
        console.warn(`Default search engine "${config.defaultSearchEngine}" is not in the allowed engines list`);
        // Update the default engine to the first allowed engine
        config.defaultSearchEngine = config.allowedSearchEngines[0] as AppConfig['defaultSearchEngine'];
        console.error(`Default search engine updated to "${config.defaultSearchEngine}"`);
    }
}

if (!quietStartupLogs) {
    // Log configuration
    console.error(`🔍 Default search engine: ${config.defaultSearchEngine}`);
    if (config.allowedSearchEngines.length > 0) {
        console.error(`🔍 Allowed search engines: ${config.allowedSearchEngines.join(', ')}`);
    } else {
        console.error(`🔍 No search engine restrictions, all available engines can be used`);
    }
    console.error(`🔍 Search mode: ${config.searchMode.toUpperCase()} (currently only affects Bing)`);
    if (!config.bingPlaywrightFallback) {
        console.error(`🔍 Bing Playwright fallback disabled (BING_PLAYWRIGHT_FALLBACK=false): anti-bot blocks surface as errors so lighter engines can cascade in`);
    }

    if (config.useProxy) {
        console.error(`🌐 Using proxy: ${config.proxyUrl}`);
    } else {
        console.error(`🌐 No proxy configured (set USE_PROXY=true to enable)`);
    }
    if (config.fakeIpCidrs.length > 0) {
        console.error(`🌐 Fake IP CIDRs: ${config.fakeIpCidrs.join(', ')}`);
    }
    if (config.fetchWebAllowInsecureTls) {
        console.error('⚠️ fetchWebContent TLS verification is disabled (FETCH_WEB_INSECURE_TLS=true)');
    } else {
        console.error('🔐 fetchWebContent TLS verification is enabled');
    }

    console.error(`🧭 Playwright client source: ${config.playwrightPackage}`);
    if (config.playwrightModulePath) {
        console.error(`🧭 Playwright module path override: ${config.playwrightModulePath}`);
    }
    if (config.playwrightWsEndpoint) {
        console.error(`🧭 Playwright remote endpoint (ws): ${config.playwrightWsEndpoint}`);
    } else if (config.playwrightCdpEndpoint) {
        console.error(`🧭 Playwright remote endpoint (cdp): ${config.playwrightCdpEndpoint}`);
    } else if (config.playwrightExecutablePath) {
        console.error(`🧭 Playwright executable path: ${config.playwrightExecutablePath}`);
    }
    console.error(`🧭 Playwright headless: ${config.playwrightHeadless}`);
    console.error(`🧭 Playwright navigation timeout: ${config.playwrightNavigationTimeoutMs}ms`);

    // Determine server mode from config
    const mode = process.env.MODE || (config.enableHttpServer ? 'both' : 'stdio');
    console.error(`🖥️ Server mode: ${mode.toUpperCase()}`);

    if (config.enableHttpServer) {
        if (config.enableCors) {
            console.error(`🔒 CORS enabled with origin: ${config.corsOrigin}`);
        } else {
            console.error(`🔒 CORS disabled (set ENABLE_CORS=true to enable)`);
        }
    }
}


/**
 * Helper function to get the proxy URL if proxy is enabled
 */
export function getProxyUrl(): string | undefined {
    return config.useProxy ? encodeURI(<string>config.proxyUrl) : undefined;
}

// 判断某个引擎是否应走代理：USE_PROXY=true 时，若 PROXY_ENGINES 白名单为空则全部走代理（兼容旧全局行为），
// 否则仅白名单内的引擎走代理（国内引擎如 bing/baidu 保持直连，避免绕行国外节点导致超时/重定向）。
export function engineShouldUseProxy(engine: string): boolean {
    if (!config.useProxy) {
        return false;
    }
    if (config.proxyEngines.length === 0) {
        return true;
    }
    return config.proxyEngines.includes(engine);
}
