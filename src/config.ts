// src/config.ts
import ipaddr from 'ipaddr.js';
import {
    loadApplicationConfigEnv,
    sanitizePathForLog,
    shouldEmitConfigStartupLog
} from './configLoader.js';

export const KNOWN_PLAYWRIGHT_ENGINES = ['bing', 'startpage'] as const;
export type KnownPlaywrightEngine = typeof KNOWN_PLAYWRIGHT_ENGINES[number];
export type SearchEngineMode = 'request' | 'auto' | 'playwright';

export interface ParsedSearchMode {
    searchMode: SearchEngineMode;
    engineSearchModes: Record<string, SearchEngineMode>;
    playwrightEngines: string[];
}

export interface AppConfig {
    // Search engine configuration
    // 'auto'：按查询特征（中英文/技术词）自动选择默认引擎，见 queryEngineRouting.ts
    defaultSearchEngine: 'auto' | 'bing' | 'duckduckgo' | 'exa' | 'brave' | 'baidu' | 'csdn' | 'juejin' | 'startpage' | 'sogou' | 'github' | 'stackoverflow' | 'hackernews' | 'arxiv';
    // List of allowed search engines (if empty, all engines are available)
    allowedSearchEngines: string[];
    // Search mode: request only, auto request then fallback, or force Playwright
    searchMode: SearchEngineMode;
    // 单个引擎的检索模式精准覆盖（支持多启动方式混合配置）
    engineSearchModes?: Record<string, SearchEngineMode>;
    // 允许启用/回退至 Playwright 浏览器的引擎列表（如 ['bing', 'startpage']）
    playwrightEngines: string[];
    // 全局并发搜索限制：同时进行的搜索请求数上限（0 = 不限制）。
    // CLI 一次性调用不受此限制，仅 daemon 模式下多客户端并发时生效。
    maxConcurrentSearches: number;
    // 向后兼容保留的独立兜底开关属性（由 SEARCH_MODE 自动推导）
    bingPlaywrightFallback: boolean;
    /** Bing 搜索请求基础 URL（默认 https://cn.bing.com/search，面向国内免翻；支持配置为 www.bing.com 或自建反代） */
    bingBaseUrl: string;
    /** 指纹请求（wreq-js）的浏览器 profile 与平台，如 chrome_149 / windows */
    impersonateBrowser: string;
    impersonateOs: string;
    // 向后兼容保留的独立兜底开关属性（由 SEARCH_MODE 自动推导）
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
    /** DEFAULT_SEARCH_ENGINE=auto 时的中英文默认路由引擎组覆盖（AUTO_ROUTE_EN_ENGINES / AUTO_ROUTE_ZH_ENGINES） */
    autoRouteEnEngines?: string[];
    autoRouteZhEngines?: string[];
    /** 工具未显式传 limit/minResults 时的服务端默认（把部署策略从工具参数移到 env） */
    defaultSearchLimit: number;
    /** 级联补位阈值：按"可用结果"（相关、非入口页）计，噪声占位时仍会补跑其他引擎 */
    defaultMinResults: number;
    /** 搜索级总时间预算（ms）：到点后未完成的引擎按超时处理 */
    searchDeadlineMs: number;
    fetchWebAllowInsecureTls: boolean;
    // Playwright configuration (auto-detects local system Edge/Chrome or connects via CDP)
    playwrightExecutablePath?: string;
    playwrightCdpEndpoint?: string;
    playwrightHeadless: boolean;
    playwrightNavigationTimeoutMs: number;
    // Server configuration (determined by MODE env var: 'both', 'http', or 'stdio')
    enableHttpServer: boolean;
    // CORS configuration for HTTP/SSE server (disabled by default to tighten local cross-site access)
    enableCors?: boolean;
    corsOrigin?: string;
}

const validSearchEngines = ['auto', 'bing', 'duckduckgo', 'exa', 'brave', 'baidu', 'csdn', 'juejin', 'startpage', 'sogou', 'github', 'stackoverflow', 'hackernews', 'arxiv'];

export interface CreateConfigOptions {
    quiet?: boolean;
}

function normalizeModeToken(token: string): SearchEngineMode | undefined {
    const t = token.trim().toLowerCase();
    if (t === 'auto') return 'auto';
    if (t === 'request' || t === 'none' || t === 'false') return 'request';
    if (t === 'playwright' || t === 'all') return 'playwright';
    return undefined;
}

function splitModeSegments(raw: string): string[] {
    // 优先按分号 ; 或换行符分割
    if (raw.includes(';') || raw.includes('\n')) {
        return raw.split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
    }
    // 若没有分号，但包含逗号，检查是否有多个 mode: 前缀（例如 "playwright:bing,auto:startpage"）
    if (raw.includes(',') && raw.includes(':')) {
        const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
        const segments: string[] = [];
        let currentSegment = '';
        for (const part of parts) {
            if (part.includes(':')) {
                if (currentSegment) {
                    segments.push(currentSegment);
                }
                currentSegment = part;
            } else {
                if (currentSegment) {
                    currentSegment += ',' + part;
                } else {
                    currentSegment = part;
                }
            }
        }
        if (currentSegment) {
            segments.push(currentSegment);
        }
        return segments;
    }
    return [raw.trim()];
}

/**
 * 解析 SEARCH_MODE 配置（支持运行模式声明、单一模式多选引擎、以及多启动方式组合）：
 * 1. 单一全局模式：`auto` / `request` / `playwright` / `none` / `all`
 * 2. 一种模式多选引擎：`playwright:bing,startpage` 或 `auto:bing,startpage`
 * 3. 多种启动方式组合：`playwright:bing;auto:startpage` 或 `auto;request:startpage`
 * 4. 纯引擎简写白名单：`bing,startpage`（自动进入 auto，未列出引擎纯 HTTP）
 * 同时静默向后兼容历史环境变量 BING_PLAYWRIGHT_FALLBACK 与 STARTPAGE_PLAYWRIGHT_FALLBACK。
 */
export function parseSearchModeConfig(
    rawMode?: string,
    legacyBingFallback?: string,
    legacyStartpageFallback?: string
): ParsedSearchMode {
    const raw = (rawMode || '').trim();
    if (!raw) {
        return applyLegacyOverrides(
            {
                searchMode: 'auto',
                engineSearchModes: {},
                playwrightEngines: [...KNOWN_PLAYWRIGHT_ENGINES]
            },
            legacyBingFallback,
            legacyStartpageFallback
        );
    }

    const segments = splitModeSegments(raw);
    let defaultMode: SearchEngineMode = 'auto';
    const engineSearchModes: Record<string, SearchEngineMode> = {};
    let hasExplicitDefault = false;
    let hasEngineLists = false;

    for (const segment of segments) {
        const pureMode = normalizeModeToken(segment);
        if (pureMode !== undefined) {
            defaultMode = pureMode;
            hasExplicitDefault = true;
            continue;
        }

        if (segment.includes(':')) {
            const [modePart = '', enginesPart = ''] = segment.split(':', 2);
            const mode = normalizeModeToken(modePart) ?? 'auto';
            const engines = enginesPart.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
            if (engines.length === 0 || engines.includes('all') || engines.includes('*')) {
                defaultMode = mode;
                hasExplicitDefault = true;
            } else {
                for (const eng of engines) {
                    engineSearchModes[eng] = mode;
                }
                hasEngineLists = true;
            }
        } else {
            // 没有冒号的纯引擎列表，如 "bing,startpage"
            const engines = segment.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
            const matched = engines.filter(e => (KNOWN_PLAYWRIGHT_ENGINES as readonly string[]).includes(e));
            if (matched.length > 0) {
                for (const eng of matched) {
                    engineSearchModes[eng] = 'auto';
                }
                hasEngineLists = true;
            }
        }
    }

    // 若用户仅指定了特定引擎（如 SEARCH_MODE=bing 或 SEARCH_MODE=playwright:bing）且未显式指定全局默认，
    // 则未列出的引擎默认进入 request 模式（纯 HTTP，不启动浏览器）
    if (hasEngineLists && !hasExplicitDefault) {
        defaultMode = 'request';
    }

    // 计算哪些引擎允许使用 Playwright（mode 为 auto 或 playwright）
    const playwrightEngines: string[] = [];
    for (const eng of KNOWN_PLAYWRIGHT_ENGINES) {
        const effectiveMode = engineSearchModes[eng] ?? defaultMode;
        if (effectiveMode === 'auto' || effectiveMode === 'playwright') {
            playwrightEngines.push(eng);
        }
    }

    return applyLegacyOverrides(
        {
            searchMode: defaultMode,
            engineSearchModes,
            playwrightEngines
        },
        legacyBingFallback,
        legacyStartpageFallback
    );
}

function applyLegacyOverrides(
    parsed: ParsedSearchMode,
    legacyBingFallback?: string,
    legacyStartpageFallback?: string
): ParsedSearchMode {
    if (legacyBingFallback === 'false') {
        parsed.engineSearchModes['bing'] = 'request';
        parsed.playwrightEngines = parsed.playwrightEngines.filter(e => e !== 'bing');
    }
    if (legacyStartpageFallback === 'false') {
        parsed.engineSearchModes['startpage'] = 'request';
        parsed.playwrightEngines = parsed.playwrightEngines.filter(e => e !== 'startpage');
    }
    return parsed;
}

export const DEFAULT_PROXY_URL = 'http://127.0.0.1:7897';
export const DEFAULT_PROXY_ENGINES = ['duckduckgo', 'exa', 'brave', 'startpage', 'github', 'stackoverflow', 'hackernews', 'arxiv'];

export interface ParsedProxyConfig {
    useProxy: boolean;
    proxyUrl: string;
    proxyEngines: string[];
}

/**
 * 解析代理配置（统一合并 PROXY_URL、USE_PROXY、PROXY_ENGINES）：
 * - PROXY_URL 默认值改为 http://127.0.0.1:7897
 * - 允许传空值（""），传空代表使用默认值并启用代理
 * - 支持 "true" / "1" 开启默认代理
 * - 支持 "false" / "none" / "off" / "0" / "direct" / "no" 显式关闭代理
 * - 支持嵌入引擎清单（如 "http://127.0.0.1:7897;duckduckgo,brave" 或 ";all"）
 * - 默认代理引擎为海外引擎（duckduckgo, exa, brave, startpage），国内引擎直连
 * - 100% 向下兼容旧的 USE_PROXY 与 PROXY_ENGINES
 */
export function parseProxyConfig(
    rawProxyUrl?: string,
    rawUseProxy?: string,
    rawProxyEngines?: string
): ParsedProxyConfig {
    const isUrlProvided = rawProxyUrl !== undefined;
    const trimmedUrl = rawProxyUrl !== undefined ? rawProxyUrl.trim() : undefined;

    const isExplicitlyDisabled =
        trimmedUrl !== undefined &&
        ['false', 'none', 'off', '0', 'direct', 'no'].includes(trimmedUrl.toLowerCase());

    let parsedUrl = DEFAULT_PROXY_URL;
    let inlineEngines: string[] | undefined = undefined;

    if (trimmedUrl && !isExplicitlyDisabled) {
        let urlPart = trimmedUrl;
        let enginesPart = '';

        if (urlPart.includes(';')) {
            const idx = urlPart.indexOf(';');
            enginesPart = urlPart.slice(idx + 1).trim();
            urlPart = urlPart.slice(0, idx).trim();
        } else if (urlPart.includes('#')) {
            const idx = urlPart.indexOf('#');
            enginesPart = urlPart.slice(idx + 1).trim();
            urlPart = urlPart.slice(0, idx).trim();
        } else if (urlPart.includes('?engines=')) {
            const idx = urlPart.indexOf('?engines=');
            enginesPart = urlPart.slice(idx + 9).trim();
            urlPart = urlPart.slice(0, idx).trim();
        }

        // 允许只传引擎清单而省略 URL（如 PROXY_URL="duckduckgo,brave" 或 "all"）
        if (
            urlPart &&
            !urlPart.includes('://') &&
            !urlPart.includes(':') &&
            (urlPart.toLowerCase() === 'all' || urlPart.includes(','))
        ) {
            enginesPart = urlPart;
            urlPart = '';
        }

        if (urlPart === '' || urlPart === 'true' || urlPart === '1' || urlPart === 'default') {
            parsedUrl = DEFAULT_PROXY_URL;
        } else if (urlPart) {
            const withProtocol = urlPart.includes('://') ? urlPart : `http://${urlPart}`;
            parsedUrl = withProtocol.replace(/\/$/, '');
        }

        if (enginesPart) {
            if (enginesPart.toLowerCase() === 'all') {
                inlineEngines = [];
            } else {
                inlineEngines = enginesPart.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
            }
        }
    } else if (trimmedUrl === '') {
        // 允许传空，传空代表默认值
        parsedUrl = DEFAULT_PROXY_URL;
    }

    let finalEngines: string[];
    if (rawProxyEngines !== undefined) {
        // 兼容旧环境变量 PROXY_ENGINES：空字符串代表全部走代理
        finalEngines = rawProxyEngines.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    } else if (inlineEngines !== undefined) {
        finalEngines = inlineEngines;
    } else {
        finalEngines = [...DEFAULT_PROXY_ENGINES];
    }

    let useProxy = false;
    if (isUrlProvided) {
        if (isExplicitlyDisabled) {
            useProxy = false;
        } else if (rawUseProxy === 'false' && rawProxyUrl !== '' && rawProxyUrl !== 'true') {
            useProxy = false;
        } else {
            useProxy = true;
        }
    } else if (rawUseProxy !== undefined) {
        useProxy = rawUseProxy === 'true';
    } else {
        useProxy = false;
    }

    return {
        useProxy,
        proxyUrl: parsedUrl,
        proxyEngines: finalEngines
    };
}

export function parsePositiveIntEnv(rawValue: string | undefined, fallback: number, min?: number, max?: number): number {
    if (rawValue === undefined || rawValue === '') {
        return fallback;
    }
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return fallback;
    }
    if (min !== undefined && parsed < min) {
        return fallback;
    }
    if (max !== undefined && parsed > max) {
        return fallback;
    }
    return parsed;
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

    const parsedSearchMode = parseSearchModeConfig(
        env.SEARCH_MODE,
        env.BING_PLAYWRIGHT_FALLBACK,
        env.STARTPAGE_PLAYWRIGHT_FALLBACK
    );

    const parsedProxy = parseProxyConfig(
        env.PROXY_URL,
        env.USE_PROXY,
        env.PROXY_ENGINES
    );

    const cfg: AppConfig = {
        defaultSearchEngine: (env.DEFAULT_SEARCH_ENGINE as AppConfig['defaultSearchEngine']) || 'auto',
        allowedSearchEngines: env.ALLOWED_SEARCH_ENGINES ?
            env.ALLOWED_SEARCH_ENGINES.split(',').map(e => e.trim()) :
            [],
        searchMode: parsedSearchMode.searchMode,
        engineSearchModes: parsedSearchMode.engineSearchModes,
        playwrightEngines: parsedSearchMode.playwrightEngines,
        bingPlaywrightFallback: parsedSearchMode.playwrightEngines.includes('bing') && (parsedSearchMode.engineSearchModes['bing'] ?? parsedSearchMode.searchMode) !== 'request',
        bingBaseUrl: (env.BING_BASE_URL || env.OPEN_WEBSEARCH_BING_HOST || 'https://cn.bing.com/search').trim().replace(/\/$/, ''),
        startpagePlaywrightFallback: parsedSearchMode.playwrightEngines.includes('startpage') && (parsedSearchMode.engineSearchModes['startpage'] ?? parsedSearchMode.searchMode) !== 'request',
        maxConcurrentSearches: parsePositiveIntEnv(env.MAX_CONCURRENT_SEARCHES, 20, 0),
        impersonateBrowser: readOptionalEnv('IMPERSONATE_BROWSER') || 'chrome_149',
        impersonateOs: readOptionalEnv('IMPERSONATE_OS') || 'windows',
        proxyUrl: parsedProxy.proxyUrl,
        useProxy: parsedProxy.useProxy,
        proxyEngines: parsedProxy.proxyEngines,
        fakeIpCidrs: env.FAKE_IP_CIDRS ?
            env.FAKE_IP_CIDRS.split(',').map(cidr => cidr.trim()).filter(Boolean) :
            ['198.18.0.0/15'],
        authorityDomains: env.SEARCH_AUTHORITY_DOMAINS ?
            env.SEARCH_AUTHORITY_DOMAINS.split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean) :
            [],
        autoRouteEnEngines: env.AUTO_ROUTE_EN_ENGINES ?
            env.AUTO_ROUTE_EN_ENGINES.split(',').map(e => e.trim().toLowerCase()).filter(Boolean) :
            undefined,
        autoRouteZhEngines: env.AUTO_ROUTE_ZH_ENGINES ?
            env.AUTO_ROUTE_ZH_ENGINES.split(',').map(e => e.trim().toLowerCase()).filter(Boolean) :
            undefined,
        defaultSearchLimit: parsePositiveIntEnv(env.DEFAULT_SEARCH_LIMIT, 10, 1, 50),
        defaultMinResults: parsePositiveIntEnv(env.DEFAULT_MIN_RESULTS, 5, 0, 50),
        searchDeadlineMs: parsePositiveIntEnv(env.SEARCH_DEADLINE_MS, 30000, 1000, 300000),
        fetchWebAllowInsecureTls: env.FETCH_WEB_INSECURE_TLS === 'true',
        playwrightExecutablePath: readOptionalEnv('PLAYWRIGHT_EXECUTABLE_PATH'),
        playwrightCdpEndpoint: readOptionalEnv('PLAYWRIGHT_CDP_ENDPOINT'),
        playwrightHeadless: env.PLAYWRIGHT_HEADLESS !== 'false',
        playwrightNavigationTimeoutMs: parsePositiveIntEnv(env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS, 20000, 1000, 300000),
        enableHttpServer: env.MODE ? ['both', 'http'].includes(env.MODE) : true,
        enableCors: env.ENABLE_CORS === 'true',
        corsOrigin: readOptionalEnv('CORS_ORIGIN') || '*'
    };

    if (!validSearchEngines.includes(cfg.defaultSearchEngine)) {
        if (!options.quiet) {
            console.warn(`Invalid DEFAULT_SEARCH_ENGINE: "${cfg.defaultSearchEngine}", falling back to "bing"`);
        }
        cfg.defaultSearchEngine = 'bing';
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

    const quietStartupLogs = !shouldEmitConfigStartupLog(env, options.quiet);

    if (cfg.playwrightCdpEndpoint && cfg.playwrightExecutablePath && !quietStartupLogs) {
        console.warn('PLAYWRIGHT_EXECUTABLE_PATH is ignored when connecting to a remote browser endpoint');
    }

    if (cfg.allowedSearchEngines.length > 0) {
        const invalidEngines = cfg.allowedSearchEngines.filter(engine => !validSearchEngines.includes(engine));
        if (invalidEngines.length > 0 && !quietStartupLogs) {
            console.warn(`Invalid search engines detected and will be ignored: ${invalidEngines.join(', ')}`);
        }
        cfg.allowedSearchEngines = cfg.allowedSearchEngines.filter(engine => validSearchEngines.includes(engine));

        if (cfg.allowedSearchEngines.length === 0) {
            if (!quietStartupLogs) {
                console.warn(`No valid search engines specified in the allowed list, all engines will be available`);
            }
        } else if (!cfg.allowedSearchEngines.includes(cfg.defaultSearchEngine)) {
            if (!quietStartupLogs) {
                console.warn(`Default search engine "${cfg.defaultSearchEngine}" is not in the allowed engines list`);
            }
            cfg.defaultSearchEngine = cfg.allowedSearchEngines[0] as AppConfig['defaultSearchEngine'];
            if (!quietStartupLogs) {
                console.error(`Default search engine updated to "${cfg.defaultSearchEngine}"`);
            }
        }
    }

    if (!quietStartupLogs) {
        for (const line of formatSanitizedConfigSummary(cfg, env)) {
            console.error(line);
        }
    }

    return cfg;
}

/**
 * 统一对代理 URL、CDP 端点等可能携带凭据或 token 的 URL 脱敏
 */
export function sanitizeUrlForLog(rawUrl: string | undefined): string {
    if (!rawUrl || !rawUrl.trim()) {
        return '';
    }
    const maskedAuth = rawUrl.replace(
        /(\b(?:https?|socks5h?|socks4a?|wss?):\/\/)([^/@\s]+)@/gi,
        '$1***:***@'
    );
    return maskedAuth.replace(
        /([?&](?:token|key|api_key|apikey|secret|password|auth)=)([^&#\s]+)/gi,
        '$1***'
    );
}

/**
 * 生成统一脱敏后的启动/诊断配置摘要（对路径、代理、CDP URL、API Key 全面脱敏）。
 * 供正常启动日志以及单元测试失败 / DEBUG_TEST_LOGS=true 时安全输出。
 */
export function formatSanitizedConfigSummary(
    cfg: AppConfig,
    env: NodeJS.ProcessEnv = process.env
): string[] {
    const lines: string[] = [];
    lines.push(`🔍 Default search engine: ${cfg.defaultSearchEngine}`);
    if (cfg.allowedSearchEngines.length > 0) {
        lines.push(`🔍 Allowed search engines: ${cfg.allowedSearchEngines.join(', ')}`);
    } else {
        lines.push(`🔍 No search engine restrictions, all available engines can be used`);
    }
    lines.push(`🔍 Search mode: ${cfg.searchMode.toUpperCase()}`);
    const overrides = Object.entries(cfg.engineSearchModes || {});
    if (overrides.length > 0) {
        lines.push(`🔍 Engine search modes: ${overrides.map(([eng, m]) => `${eng}=${m}`).join(', ')}`);
    }
    if (cfg.bingBaseUrl !== 'https://cn.bing.com/search') {
        lines.push(`🔍 Bing base URL: ${sanitizeUrlForLog(cfg.bingBaseUrl)}`);
    }
    if (cfg.playwrightEngines.length > 0) {
        lines.push(`🔍 Playwright fallback engines: ${cfg.playwrightEngines.join(', ')}`);
    } else {
        lines.push(`🔍 Playwright fallback: disabled (pure HTTP mode)`);
    }

    if (cfg.useProxy) {
        lines.push(`🌐 Using proxy: ${sanitizeUrlForLog(cfg.proxyUrl)}`);
        if (cfg.proxyEngines.length > 0) {
            lines.push(`🌐 Proxy engines: ${cfg.proxyEngines.join(', ')}`);
        } else {
            lines.push(`🌐 Proxy engines: all engines`);
        }
    } else {
        lines.push(`🌐 Proxy: disabled (set PROXY_URL to enable, or using TUN mode)`);
    }
    if (cfg.fakeIpCidrs.length > 0) {
        lines.push(`🌐 Fake IP CIDRs: ${cfg.fakeIpCidrs.join(', ')}`);
    }
    if (cfg.fetchWebAllowInsecureTls) {
        lines.push('⚠️ fetchWebContent TLS verification is disabled (FETCH_WEB_INSECURE_TLS=true)');
    } else {
        lines.push('🔐 fetchWebContent TLS verification is enabled');
    }

    if (cfg.playwrightCdpEndpoint) {
        lines.push(`🧭 Playwright remote CDP endpoint: ${sanitizeUrlForLog(cfg.playwrightCdpEndpoint)}`);
    } else if (cfg.playwrightExecutablePath) {
        lines.push(`🧭 Playwright executable path: ${sanitizePathForLog(cfg.playwrightExecutablePath)}`);
    } else {
        lines.push('🧭 Playwright client: auto-discovery (system browser or installed package)');
    }
    lines.push(`🧭 Playwright headless: ${cfg.playwrightHeadless}`);
    lines.push(`🧭 Playwright navigation timeout: ${cfg.playwrightNavigationTimeoutMs}ms`);

    const mode = env.MODE || (cfg.enableHttpServer ? 'both' : 'stdio');
    lines.push(`🖥️ Server mode: ${mode.toUpperCase()}`);

    if (cfg.enableHttpServer) {
        if (cfg.enableCors) {
            lines.push(`🔒 CORS enabled for origin: ${cfg.corsOrigin || '*'}`);
        } else {
            lines.push('🔒 CORS disabled by default (set ENABLE_CORS=true to enable)');
        }
    }

    return lines;
}

// 保持向后兼容的全局单例配置
export const config: AppConfig = createConfig(process.env);

/**
 * Helper function to get the proxy URL if proxy is enabled
 */
export function getProxyUrl(cfg: AppConfig = config): string | undefined {
    if (!cfg.useProxy || !cfg.proxyUrl) {
        return undefined;
    }
    try {
        const parsed = new URL(cfg.proxyUrl);
        const str = parsed.toString();
        if (str.endsWith('/') && !cfg.proxyUrl.endsWith('/')) {
            return str.slice(0, -1);
        }
        return str;
    } catch {
        return cfg.proxyUrl;
    }
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

// 获取指定引擎的检索模式（优先使用 engineSearchModes 覆盖，否则回退到全局 searchMode）
export function getEngineSearchMode(engine: string, cfg: AppConfig = config): SearchEngineMode {
    const normalized = engine.trim().toLowerCase();
    const override = cfg.engineSearchModes?.[normalized];
    if (override) {
        return override;
    }
    return cfg.searchMode;
}

// 判断某个引擎是否允许回退到 Playwright（模式为 auto 或 playwright）
export function engineShouldUsePlaywrightFallback(engine: string, cfg: AppConfig = config): boolean {
    const mode = getEngineSearchMode(engine, cfg);
    return mode === 'auto' || mode === 'playwright';
}


