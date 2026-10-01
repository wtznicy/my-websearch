// src/config.ts
import ipaddr from 'ipaddr.js';
import { loadApplicationConfigEnv } from './configLoader.js';

export interface AppConfig {
    // Search engine configuration
    // 'auto'：按查询特征（中英文/技术词）自动选择默认引擎，见 queryEngineRouting.ts
    defaultSearchEngine: 'auto' | 'bing' | 'duckduckgo' | 'exa' | 'brave' | 'baidu' | 'csdn' | 'juejin' | 'startpage' | 'sogou';
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
    // Bing HTTP 模式使用的浏览器指纹目标（wreq-js 的 impersonate profile，
    // 见下方 impersonateBrowser；Chrome 指纹保鲜期以年计，
    // 被反爬标记时才需要切到更新的目标）。
    /** 指纹请求（wreq-js）的浏览器 profile 与平台，如 chrome_149 / windows */
    impersonateBrowser: string;
    impersonateOs: string;
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
    /** 结果重排的额外权威域名（追加在内置白名单之后，逗号分隔） */
    authorityDomains: string[];
    /** 工具未显式传 limit/minResults 时的服务端默认（把部署策略从工具参数移到 env） */
    defaultSearchLimit: number;
    /** 级联补位阈值：按"可用结果"（相关、非入口页）计，噪声占位时仍会补跑其他引擎 */
    defaultMinResults: number;
    /** 搜索级总时间预算（ms）：到点后未完成的引擎按超时处理 */
    searchDeadlineMs: number;
    /** DEFAULT_SEARCH_ENGINE=auto 时的路由引擎组：英文（默认 bing+duckduckgo 并列，避免押注单点） */
    autoRouteEnEngines: string[];
    /** DEFAULT_SEARCH_ENGINE=auto 时的路由引擎组：中文（默认 baidu） */
    autoRouteZhEngines: string[];
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

const validSearchEngines = ['auto', 'bing', 'duckduckgo', 'exa', 'brave', 'baidu', 'csdn', 'juejin', 'startpage', 'sogou'];
const validSearchModes = ['request', 'auto', 'playwright'];
const validPlaywrightPackages = ['auto', 'playwright', 'playwright-core'];

export interface CreateConfigOptions {
    quiet?: boolean;
}

/**
 * 工厂函数：基于给定的环境变量字典创建独立的 AppConfig 实例（默认 process.env）。
 * 解锁测试隔离与多实例支持。
 */
export function createConfig(
    env: NodeJS.ProcessEnv = process.env,
    options: CreateConfigOptions = {}
): AppConfig {
    // 启动时一次性加载应用级与本地配置（~/.my-websearch/config.json / .env），仅补充缺失的环境变量
    loadApplicationConfigEnv(env, { quiet: options.quiet });

    const readOptionalEnv = (name: string): string | undefined => {
        const value = env[name]?.trim();
        return value ? value : undefined;
    };

    const cfg: AppConfig = {
        defaultSearchEngine: (env.DEFAULT_SEARCH_ENGINE as AppConfig['defaultSearchEngine']) || 'auto',
        allowedSearchEngines: env.ALLOWED_SEARCH_ENGINES ?
            env.ALLOWED_SEARCH_ENGINES.split(',').map(e => e.trim()) :
            [],
        searchMode: (env.SEARCH_MODE as AppConfig['searchMode']) || 'auto',
        maxConcurrentSearches: Number(env.MAX_CONCURRENT_SEARCHES || '20'),
        bingPlaywrightFallback: env.BING_PLAYWRIGHT_FALLBACK !== 'false',
        impersonateBrowser: readOptionalEnv('IMPERSONATE_BROWSER') || 'chrome_149',
        impersonateOs: readOptionalEnv('IMPERSONATE_OS') || 'windows',
        startpagePlaywrightFallback: env.STARTPAGE_PLAYWRIGHT_FALLBACK !== 'false',
        proxyUrl: env.PROXY_URL || 'http://127.0.0.1:7890',
        useProxy: env.USE_PROXY === 'true',
        proxyEngines: env.PROXY_ENGINES ?
            env.PROXY_ENGINES.split(',').map(e => e.trim()).filter(Boolean) :
            [],
        fakeIpCidrs: env.FAKE_IP_CIDRS ?
            env.FAKE_IP_CIDRS.split(',').map(cidr => cidr.trim()).filter(Boolean) :
            ['198.18.0.0/15'],
        authorityDomains: env.SEARCH_AUTHORITY_DOMAINS ?
            env.SEARCH_AUTHORITY_DOMAINS.split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean) :
            [],
        defaultSearchLimit: Number(env.DEFAULT_SEARCH_LIMIT || '10'),
        autoRouteEnEngines: env.AUTO_ROUTE_EN_ENGINES ?
            env.AUTO_ROUTE_EN_ENGINES.split(',').map(e => e.trim()).filter(Boolean) :
            ['bing', 'duckduckgo'],
        autoRouteZhEngines: env.AUTO_ROUTE_ZH_ENGINES ?
            env.AUTO_ROUTE_ZH_ENGINES.split(',').map(e => e.trim()).filter(Boolean) :
            ['baidu'],
        defaultMinResults: Number(env.DEFAULT_MIN_RESULTS || '5'),
        searchDeadlineMs: Number(env.SEARCH_DEADLINE_MS || '30000'),
        fetchWebAllowInsecureTls: env.FETCH_WEB_INSECURE_TLS === 'true',
        playwrightPackage: (env.PLAYWRIGHT_PACKAGE as AppConfig['playwrightPackage']) || 'auto',
        playwrightModulePath: readOptionalEnv('PLAYWRIGHT_MODULE_PATH'),
        playwrightExecutablePath: readOptionalEnv('PLAYWRIGHT_EXECUTABLE_PATH'),
        playwrightWsEndpoint: readOptionalEnv('PLAYWRIGHT_WS_ENDPOINT'),
        playwrightCdpEndpoint: readOptionalEnv('PLAYWRIGHT_CDP_ENDPOINT'),
        playwrightHeadless: env.PLAYWRIGHT_HEADLESS !== 'false',
        playwrightNavigationTimeoutMs: Number(env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || 20000),
        enableCors: env.ENABLE_CORS === 'true',
        corsOrigin: env.CORS_ORIGIN || '*',
        enableHttpServer: env.MODE ? ['both', 'http'].includes(env.MODE) : true
    };

    if (!validSearchEngines.includes(cfg.defaultSearchEngine)) {
        if (!options.quiet) {
            console.warn(`Invalid DEFAULT_SEARCH_ENGINE: "${cfg.defaultSearchEngine}", falling back to "bing"`);
        }
        cfg.defaultSearchEngine = 'bing';
    }

    if (!validSearchModes.includes(cfg.searchMode)) {
        if (!options.quiet) {
            console.warn(`Invalid SEARCH_MODE: "${cfg.searchMode}", falling back to "auto"`);
        }
        cfg.searchMode = 'auto';
    }

    if (!validPlaywrightPackages.includes(cfg.playwrightPackage)) {
        if (!options.quiet) {
            console.warn(`Invalid PLAYWRIGHT_PACKAGE: "${cfg.playwrightPackage}", falling back to "auto"`);
        }
        cfg.playwrightPackage = 'auto';
    }

    if (cfg.fakeIpCidrs.length > 0) {
        const invalidFakeIpCidrs = cfg.fakeIpCidrs.filter((cidr) => {
            try {
                ipaddr.parseCIDR(cidr);
                return false;
            } catch {
                return true;
            }
        });
        if (invalidFakeIpCidrs.length > 0 && !options.quiet) {
            console.warn(`Invalid FAKE_IP_CIDRS entries will be ignored: ${invalidFakeIpCidrs.join(', ')}`);
        }
        cfg.fakeIpCidrs = cfg.fakeIpCidrs.filter((cidr) => {
            try {
                ipaddr.parseCIDR(cidr);
                return true;
            } catch {
                return false;
            }
        });
    }

    if (!Number.isFinite(cfg.playwrightNavigationTimeoutMs) || cfg.playwrightNavigationTimeoutMs <= 0) {
        if (!options.quiet) {
            console.warn(`Invalid PLAYWRIGHT_NAVIGATION_TIMEOUT_MS: "${env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS}", falling back to 20000`);
        }
        cfg.playwrightNavigationTimeoutMs = 20000;
    }

    if (cfg.playwrightWsEndpoint && cfg.playwrightCdpEndpoint && !options.quiet) {
        console.warn('Both PLAYWRIGHT_WS_ENDPOINT and PLAYWRIGHT_CDP_ENDPOINT are set, PLAYWRIGHT_WS_ENDPOINT will take precedence');
    }

    if ((cfg.playwrightWsEndpoint || cfg.playwrightCdpEndpoint) && cfg.playwrightExecutablePath && !options.quiet) {
        console.warn('PLAYWRIGHT_EXECUTABLE_PATH is ignored when connecting to a remote browser endpoint');
    }

    if (cfg.allowedSearchEngines.length > 0) {
        const invalidEngines = cfg.allowedSearchEngines.filter(engine => !validSearchEngines.includes(engine));
        if (invalidEngines.length > 0 && !options.quiet) {
            console.warn(`Invalid search engines detected and will be ignored: ${invalidEngines.join(', ')}`);
        }
        cfg.allowedSearchEngines = cfg.allowedSearchEngines.filter(engine => validSearchEngines.includes(engine));

        if (cfg.allowedSearchEngines.length === 0) {
            if (!options.quiet) {
                console.warn(`No valid search engines specified in the allowed list, all engines will be available`);
            }
        } else if (!cfg.allowedSearchEngines.includes(cfg.defaultSearchEngine)) {
            if (!options.quiet) {
                console.warn(`Default search engine "${cfg.defaultSearchEngine}" is not in the allowed engines list`);
            }
            cfg.defaultSearchEngine = cfg.allowedSearchEngines[0] as AppConfig['defaultSearchEngine'];
            if (!options.quiet) {
                console.error(`Default search engine updated to "${cfg.defaultSearchEngine}"`);
            }
        }
    }

    const quietStartupLogs = options.quiet
        || env.OPEN_WEBSEARCH_QUIET_STARTUP === 'true'
        || (env.LOG_LEVEL ?? '').toLowerCase() === 'quiet';

    if (!quietStartupLogs) {
        console.error(`🔍 Default search engine: ${cfg.defaultSearchEngine}`);
        if (cfg.allowedSearchEngines.length > 0) {
            console.error(`🔍 Allowed search engines: ${cfg.allowedSearchEngines.join(', ')}`);
        } else {
            console.error(`🔍 No search engine restrictions, all available engines can be used`);
        }
        console.error(`🔍 Search mode: ${cfg.searchMode.toUpperCase()} (currently only affects Bing)`);
        if (!cfg.bingPlaywrightFallback) {
            console.error(`🔍 Bing Playwright fallback disabled (BING_PLAYWRIGHT_FALLBACK=false): anti-bot blocks surface as errors so lighter engines can cascade in`);
        }

        if (cfg.useProxy) {
            console.error(`🌐 Using proxy: ${cfg.proxyUrl}`);
        } else {
            console.error(`🌐 No proxy configured (set USE_PROXY=true to enable)`);
        }
        if (cfg.fakeIpCidrs.length > 0) {
            console.error(`🌐 Fake IP CIDRs: ${cfg.fakeIpCidrs.join(', ')}`);
        }
        if (cfg.fetchWebAllowInsecureTls) {
            console.error('⚠️ fetchWebContent TLS verification is disabled (FETCH_WEB_INSECURE_TLS=true)');
        } else {
            console.error('🔐 fetchWebContent TLS verification is enabled');
        }

        console.error(`🧭 Playwright client source: ${cfg.playwrightPackage}`);
        if (cfg.playwrightModulePath) {
            console.error(`🧭 Playwright module path override: ${cfg.playwrightModulePath}`);
        }
        if (cfg.playwrightWsEndpoint) {
            console.error(`🧭 Playwright remote endpoint (ws): ${cfg.playwrightWsEndpoint}`);
        } else if (cfg.playwrightCdpEndpoint) {
            console.error(`🧭 Playwright remote endpoint (cdp): ${cfg.playwrightCdpEndpoint}`);
        } else if (cfg.playwrightExecutablePath) {
            console.error(`🧭 Playwright executable path: ${cfg.playwrightExecutablePath}`);
        }
        console.error(`🧭 Playwright headless: ${cfg.playwrightHeadless}`);
        console.error(`🧭 Playwright navigation timeout: ${cfg.playwrightNavigationTimeoutMs}ms`);

        const mode = env.MODE || (cfg.enableHttpServer ? 'both' : 'stdio');
        console.error(`🖥️ Server mode: ${mode.toUpperCase()}`);

        if (cfg.enableHttpServer) {
            if (cfg.enableCors) {
                console.error(`🔒 CORS enabled with origin: ${cfg.corsOrigin}`);
            } else {
                console.error(`🔒 CORS disabled (set ENABLE_CORS=true to enable)`);
            }
        }
    }

    return cfg;
}

// 保持向后兼容的全局单例配置
export const config: AppConfig = createConfig(process.env);

/**
 * Helper function to get the proxy URL if proxy is enabled
 */
export function getProxyUrl(cfg: AppConfig = config): string | undefined {
    return cfg.useProxy ? encodeURI(<string>cfg.proxyUrl) : undefined;
}

// 判断某个引擎是否应走代理：USE_PROXY=true 时，若 PROXY_ENGINES 白名单为空则全部走代理（兼容旧全局行为），
// 否则仅白名单内的引擎走代理（国内引擎如 bing/baidu 保持直连，避免绕行国外节点导致超时/重定向）。
export function engineShouldUseProxy(engine: string, cfg: AppConfig = config): boolean {
    if (!cfg.useProxy) {
        return false;
    }
    if (cfg.proxyEngines.length === 0) {
        return true;
    }
    return cfg.proxyEngines.includes(engine);
}
