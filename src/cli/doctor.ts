import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { AppConfig, engineShouldUseProxy, getProxyUrl } from '../config.js';
import {
    getAppConfigFilePath,
    getConfigLoadSnapshot,
    sanitizePathForLog,
    type ConfigValueSource
} from '../configLoader.js';
import {
    isBaiduAntiBotPage,
    isBingAntiBotPage,
    isBraveBlockedPage,
    isSogouChallengePage,
    isStartpageCaptchaPage,
    looksLikeBotChallengePage
} from '../core/antiBot/antiBotDetection.js';
import { isEngineCircuitOpen, resetEngineCircuits } from '../core/search/engineCircuitBreaker.js';
import { metrics } from '../core/metrics.js';
import { resetBingImpersonateStateForTests } from '../engines/bing/impersonate.js';
import { SUPPORTED_SEARCH_ENGINES, normalizeEngineName } from '../core/search/searchEngines.js';
import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';
import { BROWSER_USER_AGENT } from '../utils/constants.js';
import { buildAxiosRequestOptions, __resetDirectSlowHostCacheForTests } from '../utils/httpRequest.js';
import { isKnownUnreachableOverseasEngine, __setOverseasReachableForTests } from '../utils/overseasProbe.js';
import {
    buildPlaywrightProxy,
    getLocalBrowserExecutablePath,
    getProxyBypassRules,
    loadPlaywrightClient
} from '../utils/playwright/browserDiscovery.js';

const RECOGNIZED_ENV_KEYS = [
    'DEFAULT_SEARCH_ENGINE',
    'ALLOWED_SEARCH_ENGINES',
    'SEARCH_MODE',
    'PLAYWRIGHT_ENGINES',
    'PLAYWRIGHT_CDP_ENDPOINT',
    'PLAYWRIGHT_WS_ENDPOINT',
    'PLAYWRIGHT_EXECUTABLE_PATH',
    'PROXY_URL',
    'USE_PROXY',
    'PROXY_ENGINES',
    'SEARCH_DEADLINE_MS',
    'DEFAULT_SEARCH_LIMIT',
    'DEFAULT_MIN_RESULTS',
    'ENABLE_HTTP_SERVER',
    'ENABLE_CORS',
    'CORS_ORIGIN',
    'CONTEXT7_API_KEY',
    'EXA_API_KEY',
    'BRAVE_API_KEY',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'AUTO_ROUTE_EN_ENGINES',
    'AUTO_ROUTE_ZH_ENGINES',
    'BING_IMPERSONATE',
    'ANUBIS_MAX_POW_DIFFICULTY',
    'DIRECT_FIRST_PROBE_TIMEOUT_MS'
] as const;

const ENGINE_NETWORK_PROBE_URLS: Record<string, string> = {
    bing: 'https://cn.bing.com/search?q=mcp&count=1',
    baidu: 'https://www.baidu.com/s?wd=mcp&rn=1',
    sogou: 'https://m.sogou.com/web/searchList.jsp?keyword=mcp',
    csdn: 'https://so.csdn.net/api/v3/search?q=mcp&t=all&p=1&s=0&tm=0&lv=-1&ft=0&l=&u=',
    juejin: 'https://api.juejin.cn',
    exa: 'https://api.exa.ai',
    duckduckgo: 'https://html.duckduckgo.com/html/?q=mcp',
    brave: 'https://search.brave.com/search?q=mcp',
    startpage: 'https://www.startpage.com/sp/search?query=mcp'
};

export const DEFAULT_DOCTOR_PROBE_TTL_MS = 30_000;
export const DEFAULT_DOCTOR_PROBE_OK_TTL_MS = 30_000;
export const DEFAULT_DOCTOR_PROBE_CHALLENGE_TTL_MS = 10_000;
export const DEFAULT_DOCTOR_PROBE_FAILURE_TTL_MS = 5_000;

export type DoctorEngineProbeStage =
    | 'unchecked'
    | 'tcp_reachable'
    | 'http_reachable'
    | 'challenge'
    | 'parsed'
    | 'functional';

export type EngineNetworkProbeResult = {
    reachable: boolean;
    http?: 'reachable' | 'unreachable';
    application?: 'ok' | 'challenge' | 'parse_error' | 'unchecked';
    stage?: DoctorEngineProbeStage;
    latencyMs: number;
    probeDuration?: number;
    probeUserAgent?: string;
    error?: string;
    checkedAt?: string;
    cached?: boolean;
    ttlMs?: number;
    probeKind?: 'http_search' | 'config_only';
};

export type BrowserLaunchProbeResult = {
    available: boolean;
    status: 'configured' | 'reachable' | 'unreachable' | 'unavailable';
    mode: 'cdp' | 'executable' | 'default' | 'unavailable';
    probeKind?: 'config_only' | 'cdp_tcp' | 'browser_launch';
    target: string;
    headless: boolean;
    launched: boolean;
    pageOpened: boolean;
    isolatedProfile?: boolean;
    browserClosed?: boolean;
    latencyMs: number | null;
    error: string | null;
};

type CachedProbeEntry = {
    expiresAt: number;
    ttlMs: number;
    result: EngineNetworkProbeResult;
};

const doctorProbeCache = new Map<string, CachedProbeEntry>();

export function clearDoctorProbeCache(): void {
    doctorProbeCache.clear();
}

/**
 * 重置所有进程内熔断状态、运行时指标、指纹失败计数、直连慢主机缓存、海外探测缓存与搜索缓存。
 * 供 doctor --reset-health 或单元测试调用，防止长时间运行或网络波动污染诊断结果。
 */
export function resetAllHealthState(runtime?: MyWebSearchRuntime): void {
    resetEngineCircuits();
    metrics.reset();
    resetBingImpersonateStateForTests();
    __resetDirectSlowHostCacheForTests();
    __setOverseasReachableForTests(null);
    clearDoctorProbeCache();
    runtime?.services?.search?.clearCache?.();
}

export function isEngineProbeChallengeResponse(
    engine: string,
    status: number,
    body: string
): boolean {
    if (status === 403 || status === 429) {
        return true;
    }
    if (engine === 'duckduckgo' && status === 202) {
        return true;
    }
    if (!body || typeof body !== 'string') {
        return false;
    }
    if (engine === 'baidu' && isBaiduAntiBotPage(body)) {
        return true;
    }
    if (engine === 'bing' && isBingAntiBotPage(body)) {
        return true;
    }
    if (engine === 'sogou' && isSogouChallengePage(body)) {
        return true;
    }
    if (engine === 'brave' && isBraveBlockedPage(body)) {
        return true;
    }
    if (engine === 'startpage' && (isStartpageCaptchaPage(body) || /anubis|\/sp\/captcha/i.test(body))) {
        return true;
    }
    if (engine === 'duckduckgo' && /anomaly-modal|challenge-form|cc=botnet/i.test(body)) {
        return true;
    }
    return looksLikeBotChallengePage(body, { status });
}

export function verifyEngineProbeResponseStructure(
    engine: string,
    status: number,
    body: string
): { stage: 'http_reachable' | 'parsed' | 'functional'; application: 'ok' | 'parse_error' } {
    if (status < 200 || status >= 400) {
        return { stage: 'http_reachable', application: 'parse_error' };
    }
    if (engine === 'juejin' || engine === 'exa') {
        return { stage: 'functional', application: 'ok' };
    }
    if (!body || !body.trim()) {
        return { stage: 'http_reachable', application: 'parse_error' };
    }
    if (engine === 'csdn') {
        try {
            const parsed = JSON.parse(body) as { result_vos?: unknown[] };
            if (Array.isArray(parsed.result_vos)) {
                return {
                    stage: parsed.result_vos.length > 0 ? 'functional' : 'parsed',
                    application: 'ok'
                };
            }
        } catch {
            // fall through
        }
        return { stage: 'http_reachable', application: 'parse_error' };
    }
    const lower = body.toLowerCase();
    const hasExpectedResults: Record<string, boolean> = {
        bing: lower.includes('b_results') || lower.includes('b_algo'),
        baidu: lower.includes('content_left') || lower.includes('c-container') || lower.includes('result'),
        sogou: lower.includes('results') || lower.includes('vrresult') || lower.includes('resitem'),
        duckduckgo: lower.includes('result__a') || lower.includes('links.duckduckgo.com/d.js') || lower.includes('results'),
        brave: lower.includes('snippet') || lower.includes('results') || lower.includes('fdb'),
        startpage: lower.includes('w-gl') || lower.includes('result') || lower.includes('search-result')
    };
    if (hasExpectedResults[engine] ?? true) {
        return { stage: 'functional', application: 'ok' };
    }
    return { stage: 'http_reachable', application: 'parse_error' };
}

export function maskSecret(value: string | undefined | null): string | null {
    if (!value || !value.trim()) {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length <= 6) {
        return '***';
    }
    return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

export function maskProxyUrl(rawUrl: string | undefined | null): string {
    if (!rawUrl || !rawUrl.trim()) {
        return '';
    }
    const maskedAuth = rawUrl.trim().replace(
        /(\b(?:https?|wss?|socks5h?|socks4a?):\/\/)([^/@\s]+)@/gi,
        '$1***:***@'
    );
    return maskedAuth.replace(
        /([?&](?:token|key|api_key|apikey|secret|password|auth)=)([^&#\s]+)/gi,
        '$1***'
    );
}

export async function probeTcpEndpoint(
    urlString: string,
    timeoutMs = 1000
): Promise<{
    reachable: boolean;
    host: string;
    port: number;
    latencyMs: number;
    error?: string;
} | null> {
    if (!urlString || !urlString.trim()) {
        return null;
    }

    let parsed: URL;
    try {
        parsed = new URL(urlString.trim());
    } catch {
        return null;
    }

    const host = parsed.hostname;
    const defaultPort = (parsed.protocol === 'https:' || parsed.protocol === 'wss:')
        ? 443
        : parsed.protocol.startsWith('socks')
            ? 1080
            : 80;
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
        return null;
    }

    const startedAt = Date.now();
    return await new Promise((resolve) => {
        let settled = false;
        const socket = net.createConnection({ host, port });

        const finish = (reachable: boolean, error?: string) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            resolve({
                reachable,
                host,
                port,
                latencyMs: Date.now() - startedAt,
                ...(error ? { error } : {})
            });
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false, `TCP connection timed out after ${timeoutMs}ms`));
        socket.once('error', (err) => finish(false, err.message));
    });
}

export function sanitizeBrowserTargetForDoctor(rawTarget: string | undefined | null): string {
    if (!rawTarget || !rawTarget.trim()) {
        return '';
    }
    const homeSanitized = sanitizePathForLog(rawTarget.trim());
    if (homeSanitized.startsWith('~')) {
        return homeSanitized.replace(/\\/g, '/');
    }
    if (/^[a-zA-Z]:[\\/]/.test(homeSanitized) || homeSanitized.startsWith('/')) {
        const normalized = homeSanitized.replace(/\\/g, '/');
        const segments = normalized.split('/').filter(Boolean);
        if (segments.length <= 2) {
            return `<system>/${segments.join('/')}`;
        }
        return `<system>/${segments.slice(-2).join('/')}`;
    }
    return homeSanitized;
}

async function probeEngineHttpEndpoint(
    engine: string,
    _appConfig: AppConfig,
    timeoutMs: number
): Promise<EngineNetworkProbeResult> {
    const url = ENGINE_NETWORK_PROBE_URLS[engine] ?? 'https://www.bing.com/search?q=mcp&count=1';
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const probeUserAgent = BROWSER_USER_AGENT;
    try {
        const response = await axios.get(
            url,
            buildAxiosRequestOptions({
                engine,
                trustedStaticHost: true,
                timeout: timeoutMs,
                maxRedirects: 3,
                responseType: 'text',
                headers: {
                    'User-Agent': probeUserAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                },
                validateStatus: (status) => status >= 200 && status < 500
            })
        );
        const body = typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data ?? '');
        const latencyMs = Date.now() - startedAt;
        if (isEngineProbeChallengeResponse(engine, response.status, body)) {
            return {
                reachable: false,
                http: 'reachable',
                application: 'challenge',
                stage: 'challenge',
                latencyMs,
                probeDuration: latencyMs,
                probeUserAgent,
                checkedAt,
                error: `Upstream anti-bot challenge detected (HTTP ${response.status})`
            };
        }
        const verified = verifyEngineProbeResponseStructure(engine, response.status, body);
        if (verified.application === 'parse_error') {
            return {
                reachable: false,
                http: 'reachable',
                application: 'parse_error',
                stage: 'http_reachable',
                latencyMs,
                probeDuration: latencyMs,
                probeUserAgent,
                checkedAt,
                error: `HTTP ${response.status} received but expected search result structure was not found`
            };
        }
        return {
            reachable: true,
            http: 'reachable',
            application: 'ok',
            stage: verified.stage,
            latencyMs,
            probeDuration: latencyMs,
            probeUserAgent,
            checkedAt
        };
    } catch (error) {
        const latencyMs = Date.now() - startedAt;
        return {
            reachable: false,
            http: 'unreachable',
            application: 'unchecked',
            stage: 'unchecked',
            latencyMs,
            probeDuration: latencyMs,
            probeUserAgent,
            checkedAt,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function probeBrowserLaunch(
    appConfig: AppConfig,
    timeoutMs = 8000,
    options: {
        env?: NodeJS.ProcessEnv;
        playwrightClient?: {
            chromium?: unknown;
        } | null;
    } = {}
): Promise<BrowserLaunchProbeResult> {
    const startedAt = Date.now();
    const env = options.env ?? process.env;
    const playwright = options.playwrightClient !== undefined
        ? options.playwrightClient
        : await loadPlaywrightClient({ silent: true });
    if (!playwright || !playwright.chromium) {
        return {
            available: false,
            status: 'unavailable',
            mode: 'unavailable',
            probeKind: 'browser_launch',
            target: '',
            headless: appConfig.playwrightHeadless,
            launched: false,
            pageOpened: false,
            isolatedProfile: false,
            browserClosed: false,
            latencyMs: null,
            error: 'Playwright client package is not installed'
        };
    }

    const staticProbeUrl = 'data:text/html,<html><head><title>my-websearch-doctor</title></head><body>ok</body></html>';

    if (appConfig.playwrightCdpEndpoint) {
        const cdpTarget = maskProxyUrl(appConfig.playwrightCdpEndpoint);
        const shouldCloseCdpBrowser = (env.DOCTOR_CLOSE_CDP_BROWSER ?? '').trim().toLowerCase() === 'true';
        type ProbePageLike = {
            goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
            title(): Promise<string>;
            close(): Promise<void>;
        };
        type ProbeContextLike = {
            newPage(): Promise<ProbePageLike>;
            close(): Promise<void>;
        };
        type ProbeBrowserLike = {
            close(): Promise<void>;
            newContext?: () => Promise<ProbeContextLike>;
            newPage(): Promise<ProbePageLike>;
        };
        let browser: ProbeBrowserLike | null = null;
        let isolatedContext: ProbeContextLike | null = null;
        try {
            browser = await (playwright.chromium as {
                connectOverCDP(endpoint: string, opts?: { timeout?: number }): Promise<ProbeBrowserLike>;
            }).connectOverCDP(appConfig.playwrightCdpEndpoint, { timeout: timeoutMs });
            if (typeof browser.newContext === 'function') {
                isolatedContext = await browser.newContext().catch(() => null);
            }
            const page = isolatedContext
                ? await isolatedContext.newPage()
                : await browser.newPage();
            try {
                await page.goto(staticProbeUrl, { timeout: timeoutMs });
                const title = await page.title();
                const pageOpened = title === 'my-websearch-doctor';
                return {
                    available: pageOpened,
                    status: pageOpened ? 'reachable' : 'unreachable',
                    mode: 'cdp',
                    probeKind: 'browser_launch',
                    target: cdpTarget,
                    headless: appConfig.playwrightHeadless,
                    launched: true,
                    pageOpened,
                    isolatedProfile: Boolean(isolatedContext),
                    browserClosed: shouldCloseCdpBrowser,
                    latencyMs: Date.now() - startedAt,
                    error: pageOpened ? null : `Unexpected static page title: ${title}`
                };
            } finally {
                await page.close().catch(() => undefined);
                if (isolatedContext) {
                    await isolatedContext.close().catch(() => undefined);
                }
            }
        } catch (error) {
            return {
                available: false,
                status: 'unreachable',
                mode: 'cdp',
                probeKind: 'browser_launch',
                target: cdpTarget,
                headless: appConfig.playwrightHeadless,
                launched: false,
                pageOpened: false,
                isolatedProfile: false,
                browserClosed: false,
                latencyMs: Date.now() - startedAt,
                error: error instanceof Error ? error.message : String(error)
            };
        } finally {
            // CDP 模式下默认只关闭探测创建的临时页面/上下文，绝不主动关闭用户外部驻留的浏览器实例；
            // 仅当调用方显式指定 DOCTOR_CLOSE_CDP_BROWSER=true 时才关闭远端浏览器。
            if (browser && shouldCloseCdpBrowser) {
                await browser.close().catch(() => undefined);
            }
        }
    }

    let executablePath = '';
    try {
        executablePath = (appConfig.playwrightExecutablePath && fs.existsSync(appConfig.playwrightExecutablePath))
            ? appConfig.playwrightExecutablePath
            : getLocalBrowserExecutablePath();
    } catch (error) {
        return {
            available: false,
            status: 'unavailable',
            mode: 'unavailable',
            probeKind: 'browser_launch',
            target: '',
            headless: appConfig.playwrightHeadless,
            launched: false,
            pageOpened: false,
            isolatedProfile: false,
            browserClosed: false,
            latencyMs: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }

    const sanitizedTarget = sanitizeBrowserTargetForDoctor(executablePath);
    const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-websearch-doctor-profile-'));
    let browser: { close(): Promise<void>; newPage(): Promise<{ goto(url: string, opts?: { timeout?: number }): Promise<unknown>; title(): Promise<string>; close(): Promise<void> }> } | null = null;
    try {
        const proxy = buildPlaywrightProxy(appConfig);
        browser = await (playwright.chromium as {
            launch(opts: Record<string, unknown>): Promise<typeof browser>;
        }).launch({
            executablePath,
            headless: appConfig.playwrightHeadless,
            timeout: timeoutMs,
            args: [
                `--user-data-dir=${tempProfileDir}`,
                '--no-first-run',
                '--no-default-browser-check'
            ],
            ...(proxy ? { proxy } : {})
        });
        const page = await browser!.newPage();
        try {
            await page.goto(staticProbeUrl, { timeout: timeoutMs });
            const title = await page.title();
            const pageOpened = title === 'my-websearch-doctor';
            return {
                available: pageOpened,
                status: pageOpened ? 'reachable' : 'unreachable',
                mode: 'executable',
                probeKind: 'browser_launch',
                target: sanitizedTarget,
                headless: appConfig.playwrightHeadless,
                launched: true,
                pageOpened,
                isolatedProfile: true,
                browserClosed: true,
                latencyMs: Date.now() - startedAt,
                error: pageOpened ? null : `Unexpected static page title: ${title}`
            };
        } finally {
            await page.close().catch(() => undefined);
        }
    } catch (error) {
        return {
            available: false,
            status: 'unreachable',
            mode: 'executable',
            probeKind: 'browser_launch',
            target: sanitizedTarget,
            headless: appConfig.playwrightHeadless,
            launched: false,
            pageOpened: false,
            isolatedProfile: true,
            browserClosed: true,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error)
        };
    } finally {
        if (browser) {
            await browser.close().catch(() => undefined);
        }
        try {
            fs.rmSync(tempProfileDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
    }
}

export type DoctorEngineStatus = {
    engine: string;
    allowed: boolean;
    usesProxy: boolean;
    circuitOpen: boolean;
    knownUnreachableOverseas: boolean;
    proxyTcp: 'direct' | 'reachable' | 'unreachable' | 'unchecked';
    http: 'reachable' | 'unreachable' | 'unchecked';
    application: 'ok' | 'challenge' | 'parse_error' | 'missing_api_key' | 'unchecked';
    stage: DoctorEngineProbeStage;
    networkStatus: 'unchecked' | 'reachable' | 'unreachable';
    status:
        | 'configured'
        | 'unchecked'
        | 'reachable'
        | 'unreachable'
        | 'blocked_by_antibot'
        | 'parse_error'
        | 'missing_api_key'
        | 'circuit_open'
        | 'proxy_unreachable'
        | 'disabled_by_whitelist';
    latencyMs?: number;
    probeDuration?: number;
    probeUserAgent?: string;
    checkedAt: string;
    cached: boolean;
    ttlMs: number;
    probeKind: 'http_search' | 'config_only';
    detail?: string;
};

export type DoctorReport = {
    version: string;
    checkedAt: string;
    networkChecked: boolean;
    browserChecked: boolean;
    networkNotice?: string;
    probeUserAgent?: string;
    cachePolicy?: {
        okTtlMs: number;
        challengeTtlMs: number;
        failureTtlMs: number;
    };
    probedEngines: string[];
    configSources: {
        appConfigFile: { path: string; exists: boolean };
        projectConfigFile: { path: string; exists: boolean };
        dotEnvFile: { path: string; exists: boolean };
        envOverrides: string[];
        keySources: Record<string, ConfigValueSource>;
    };
    effectiveConfig: {
        defaultSearchEngine: string;
        allowedSearchEngines: string[];
        searchMode: string;
        useProxy: boolean;
        proxyUrl: string;
        proxyEngines: string[];
        searchDeadlineMs: number;
        enableHttpServer: boolean;
        enableCors: boolean;
        corsOrigin: string;
        apiKeys: {
            context7: string | null;
            exa: string | null;
            brave: string | null;
            github: string | null;
        };
    };
    proxy: {
        enabled: boolean;
        server: string;
        status: 'disabled' | 'configured' | 'reachable' | 'unreachable';
        networkStatus: 'disabled' | 'unchecked' | 'reachable' | 'unreachable';
        tcpReachable: boolean | null;
        reachable: boolean | null;
        latencyMs: number | null;
        error: string | null;
        bypassRules: string[];
    };
    browser: BrowserLaunchProbeResult;
    engines: DoctorEngineStatus[];
    recommendations: string[];
    healthReset?: boolean;
};

export async function buildDoctorReport(
    runtime: MyWebSearchRuntime,
    options: {
        env?: NodeJS.ProcessEnv;
        cwd?: string;
        version?: string;
        proxyProbeTimeoutMs?: number;
        network?: boolean;
        browser?: boolean;
        browserProbeTimeoutMs?: number;
        browserProbeFn?: (
            appConfig: AppConfig,
            timeoutMs: number
        ) => Promise<BrowserLaunchProbeResult>;
        engines?: string[];
        probeCacheTtlMs?: number;
        challengeProbeCacheTtlMs?: number;
        failureProbeCacheTtlMs?: number;
        networkProbeTimeoutMs?: number;
        networkProbeFn?: (
            engine: string,
            appConfig: AppConfig,
            timeoutMs: number
        ) => Promise<EngineNetworkProbeResult>;
        resetHealth?: boolean;
    } = {}
): Promise<DoctorReport> {
    if (options.resetHealth) {
        resetAllHealthState(runtime);
    }
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const version = options.version ?? 'unknown';
    const checkedAt = new Date().toISOString();
    const probeTimeoutMs = options.proxyProbeTimeoutMs ?? 1000;
    const networkChecked = options.network !== undefined
        ? Boolean(options.network)
        : Boolean(options.engines && options.engines.length > 0);
    const browserChecked = Boolean(options.browser);
    const browserProbeTimeoutMs = options.browserProbeTimeoutMs ?? 8000;
    const networkProbeTimeoutMs = options.networkProbeTimeoutMs ?? 3000;
    const rawProbeNetwork = options.networkProbeFn ?? probeEngineHttpEndpoint;
    const okCacheTtlMs = options.probeCacheTtlMs ?? (options.networkProbeFn ? 0 : DEFAULT_DOCTOR_PROBE_OK_TTL_MS);
    const challengeCacheTtlMs = options.challengeProbeCacheTtlMs
        ?? (options.probeCacheTtlMs !== undefined ? options.probeCacheTtlMs : (options.networkProbeFn ? 0 : DEFAULT_DOCTOR_PROBE_CHALLENGE_TTL_MS));
    const failureCacheTtlMs = options.failureProbeCacheTtlMs
        ?? (options.probeCacheTtlMs !== undefined ? options.probeCacheTtlMs : (options.networkProbeFn ? 0 : DEFAULT_DOCTOR_PROBE_FAILURE_TTL_MS));


    const appConfigPath = getAppConfigFilePath(env);
    const projectConfigPath = path.resolve(cwd, '.my-websearch.json');
    const dotEnvPath = path.resolve(cwd, '.env');

    const snapshot = getConfigLoadSnapshot(env);
    const keySources: Record<string, ConfigValueSource> = {};
    const envOverrides: string[] = [];

    for (const key of RECOGNIZED_ENV_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(env, key) || env[key] === undefined) {
            continue;
        }
        const currentValue = String(env[key]);
        if (
            snapshot
            && Object.prototype.hasOwnProperty.call(snapshot.injectedSources, key)
            && snapshot.injectedValues[key] === currentValue
        ) {
            keySources[key] = snapshot.injectedSources[key]!;
        } else if (currentValue.trim().length > 0 || snapshot?.initialEnvKeys.has(key)) {
            keySources[key] = 'process_env';
            envOverrides.push(key);
        }
    }

    const effectiveProxyServer = getProxyUrl(runtime.config);
    const proxyProbe = runtime.config.useProxy && effectiveProxyServer
        ? await probeTcpEndpoint(effectiveProxyServer, probeTimeoutMs)
        : null;

    let browserInfo: DoctorReport['browser'];
    if (browserChecked) {
        const rawProbeBrowser = options.browserProbeFn
            ?? ((cfg: AppConfig, timeout: number) => probeBrowserLaunch(cfg, timeout, { env }));
        const probed = await rawProbeBrowser(runtime.config, browserProbeTimeoutMs);
        browserInfo = {
            probeKind: 'browser_launch',
            ...probed
        };
    } else {
        try {
            if (runtime.config.playwrightCdpEndpoint) {
                const cdpTarget = maskProxyUrl(runtime.config.playwrightCdpEndpoint);
                const cdpProbe = await probeTcpEndpoint(runtime.config.playwrightCdpEndpoint, probeTimeoutMs);
                if (cdpProbe && cdpProbe.reachable) {
                    browserInfo = {
                        available: true,
                        status: 'reachable',
                        mode: 'cdp',
                        probeKind: 'cdp_tcp',
                        target: cdpTarget,
                        headless: runtime.config.playwrightHeadless,
                        launched: false,
                        pageOpened: false,
                        latencyMs: cdpProbe.latencyMs,
                        error: null
                    };
                } else {
                    browserInfo = {
                        available: false,
                        status: 'unreachable',
                        mode: 'cdp',
                        probeKind: 'cdp_tcp',
                        target: cdpTarget,
                        headless: runtime.config.playwrightHeadless,
                        launched: false,
                        pageOpened: false,
                        latencyMs: cdpProbe?.latencyMs ?? null,
                        error: cdpProbe?.error ?? 'CDP endpoint is not reachable'
                    };
                }
            } else {
                const executablePath = (runtime.config.playwrightExecutablePath && fs.existsSync(runtime.config.playwrightExecutablePath))
                    ? runtime.config.playwrightExecutablePath
                    : getLocalBrowserExecutablePath();
                browserInfo = {
                    available: true,
                    status: 'configured',
                    mode: 'executable',
                    probeKind: 'config_only',
                    target: sanitizeBrowserTargetForDoctor(executablePath),
                    headless: runtime.config.playwrightHeadless,
                    launched: false,
                    pageOpened: false,
                    latencyMs: null,
                    error: null
                };
            }
        } catch (error) {
            browserInfo = {
                available: false,
                status: 'unavailable',
                mode: 'unavailable',
                probeKind: 'config_only',
                target: '',
                headless: runtime.config.playwrightHeadless,
                launched: false,
                pageOpened: false,
                latencyMs: null,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    const allowedList = runtime.config.allowedSearchEngines;
    const hasExaApiKey = Boolean(env.EXA_API_KEY?.trim());

    const explicitTargets = (options.engines ?? [])
        .map((e) => normalizeEngineName(e))
        .filter((e): e is typeof SUPPORTED_SEARCH_ENGINES[number] => Boolean(e));

    const defaultRequiredEngines = allowedList.length > 0
        ? allowedList
        : Array.from(new Set([
            ...(runtime.config.defaultSearchEngine && runtime.config.defaultSearchEngine !== 'auto'
                ? [runtime.config.defaultSearchEngine]
                : []),
            'bing',
            'baidu'
        ]));

    const targetEnginesSet = new Set<string>(
        explicitTargets.length > 0 ? explicitTargets : defaultRequiredEngines
    );
    const probedEngines: string[] = [];

    const probeNetworkWithCache = async (
        engine: string,
        appConfig: AppConfig,
        timeoutMs: number
    ): Promise<EngineNetworkProbeResult> => {
        const usesProxy = engineShouldUseProxy(engine, appConfig);
        const cacheKey = `${engine}|${usesProxy ? effectiveProxyServer : 'direct'}`;
        const now = Date.now();
        if (okCacheTtlMs > 0 || challengeCacheTtlMs > 0 || failureCacheTtlMs > 0) {
            const cached = doctorProbeCache.get(cacheKey);
            if (cached && cached.expiresAt > now) {
                return {
                    ...cached.result,
                    cached: true,
                    ttlMs: cached.ttlMs,
                    probeKind: cached.result.probeKind ?? 'http_search'
                };
            }
        }
        const raw = await rawProbeNetwork(engine, appConfig, timeoutMs);
        const effectiveTtlMs = raw.application === 'challenge'
            ? challengeCacheTtlMs
            : (!raw.reachable || raw.application === 'parse_error')
                ? failureCacheTtlMs
                : okCacheTtlMs;
        const normalized: EngineNetworkProbeResult = {
            ...raw,
            probeDuration: raw.probeDuration ?? raw.latencyMs,
            probeUserAgent: raw.probeUserAgent ?? BROWSER_USER_AGENT,
            checkedAt: raw.checkedAt ?? new Date().toISOString(),
            cached: false,
            ttlMs: raw.ttlMs ?? effectiveTtlMs,
            probeKind: raw.probeKind ?? 'http_search'
        };
        if (effectiveTtlMs > 0) {
            doctorProbeCache.set(cacheKey, {
                expiresAt: now + effectiveTtlMs,
                ttlMs: effectiveTtlMs,
                result: normalized
            });
        }
        return normalized;
    };

    const engines: DoctorEngineStatus[] = await Promise.all(
        SUPPORTED_SEARCH_ENGINES.map(async (engine): Promise<DoctorEngineStatus> => {
            const allowed = allowedList.length === 0 || allowedList.includes(engine);
            const usesProxy = engineShouldUseProxy(engine, runtime.config);
            const circuitOpen = isEngineCircuitOpen(engine);
            const knownUnreachableOverseas = isKnownUnreachableOverseasEngine(engine);
            const proxyTcp: DoctorEngineStatus['proxyTcp'] = !usesProxy
                ? 'direct'
                : proxyProbe
                    ? (proxyProbe.reachable ? 'reachable' : 'unreachable')
                    : 'unchecked';

            if (!allowed && explicitTargets.length === 0) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp,
                    http: 'unchecked',
                    application: 'unchecked',
                    stage: 'unchecked',
                    networkStatus: 'unchecked',
                    status: 'disabled_by_whitelist',
                    checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only'
                };
            }

            if (engine === 'exa' && !hasExaApiKey) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp,
                    http: 'unchecked',
                    application: 'missing_api_key',
                    stage: 'unchecked',
                    networkStatus: 'unchecked',
                    status: 'missing_api_key',
                    checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only',
                    detail: 'EXA_API_KEY is not configured'
                };
            }

            if (circuitOpen) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp,
                    http: 'unchecked',
                    application: 'unchecked',
                    stage: 'unchecked',
                    networkStatus: 'unreachable',
                    status: 'circuit_open',
                    checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only'
                };
            }

            if (usesProxy && proxyProbe && !proxyProbe.reachable) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp: 'unreachable',
                    http: 'unchecked',
                    application: 'unchecked',
                    stage: 'unchecked',
                    networkStatus: 'unreachable',
                    status: 'proxy_unreachable',
                    checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only'
                };
            }

            if (knownUnreachableOverseas && !usesProxy) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp: 'direct',
                    http: 'unreachable',
                    application: 'unchecked',
                    stage: 'unchecked',
                    networkStatus: 'unreachable',
                    status: 'unreachable',
                    checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only',
                    detail: 'Direct overseas connection previously timed out; proxy recommended'
                };
            }

            if (networkChecked && targetEnginesSet.has(engine)) {
                probedEngines.push(engine);
                const netProbe = await probeNetworkWithCache(engine, runtime.config, networkProbeTimeoutMs);
                const httpStatus: DoctorEngineStatus['http'] = netProbe.http ?? (netProbe.reachable ? 'reachable' : 'unreachable');
                const appStatus: DoctorEngineStatus['application'] = netProbe.application ?? (netProbe.reachable ? 'ok' : 'unchecked');
                const stage: DoctorEngineProbeStage = netProbe.stage ?? (
                    appStatus === 'challenge'
                        ? 'challenge'
                        : appStatus === 'parse_error'
                            ? 'http_reachable'
                            : netProbe.reachable
                                ? 'functional'
                                : httpStatus === 'reachable'
                                    ? 'http_reachable'
                                    : proxyTcp === 'reachable'
                                        ? 'tcp_reachable'
                                        : 'unchecked'
                );
                const finalStatus: DoctorEngineStatus['status'] = appStatus === 'challenge'
                    ? 'blocked_by_antibot'
                    : appStatus === 'parse_error'
                        ? 'parse_error'
                        : netProbe.reachable
                            ? 'reachable'
                            : 'unreachable';

                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp,
                    http: httpStatus,
                    application: appStatus,
                    stage,
                    networkStatus: (httpStatus === 'reachable' || netProbe.reachable) ? 'reachable' : 'unreachable',
                    status: finalStatus,
                    latencyMs: netProbe.latencyMs,
                    probeDuration: netProbe.probeDuration ?? netProbe.latencyMs,
                    probeUserAgent: netProbe.probeUserAgent ?? BROWSER_USER_AGENT,
                    checkedAt: netProbe.checkedAt ?? checkedAt,
                    cached: Boolean(netProbe.cached),
                    ttlMs: netProbe.ttlMs ?? okCacheTtlMs,
                    probeKind: netProbe.probeKind ?? 'http_search',
                    ...(netProbe.error ? { detail: netProbe.error } : {})
                };
            }

            return {
                engine,
                allowed,
                usesProxy,
                circuitOpen,
                knownUnreachableOverseas,
                proxyTcp,
                http: 'unchecked',
                application: 'unchecked',
                stage: proxyTcp === 'reachable' ? 'tcp_reachable' : 'unchecked',
                networkStatus: 'unchecked',
                status: !allowed ? 'disabled_by_whitelist' : 'configured',
                checkedAt,
                cached: false,
                ttlMs: 0,
                probeKind: 'config_only'
            };
        })
    );

    let proxyStatus: DoctorReport['proxy']['status'] = 'disabled';
    let proxyNetworkStatus: DoctorReport['proxy']['networkStatus'] = 'disabled';
    let proxyError: string | null = proxyProbe?.error ?? null;

    if (runtime.config.useProxy && effectiveProxyServer) {
        if (!proxyProbe || !proxyProbe.reachable) {
            proxyStatus = 'unreachable';
            proxyNetworkStatus = 'unreachable';
        } else if (networkChecked) {
            const probedProxiedEngines = engines.filter(
                (e) => e.usesProxy && e.http !== 'unchecked'
            );
            if (probedProxiedEngines.length > 0) {
                const anyHttpReachable = probedProxiedEngines.some((e) => e.http === 'reachable');
                proxyStatus = anyHttpReachable ? 'reachable' : 'unreachable';
                proxyNetworkStatus = anyHttpReachable ? 'reachable' : 'unreachable';
                if (!anyHttpReachable) {
                    proxyError = probedProxiedEngines[0]?.detail ?? 'Upstream target unreachable via proxy';
                }
            } else {
                const upstreamProbe = await probeNetworkWithCache('duckduckgo', runtime.config, networkProbeTimeoutMs);
                const upstreamHttpReachable = (upstreamProbe.http ?? (upstreamProbe.reachable ? 'reachable' : 'unreachable')) === 'reachable';
                proxyStatus = upstreamHttpReachable ? 'reachable' : 'unreachable';
                proxyNetworkStatus = upstreamHttpReachable ? 'reachable' : 'unreachable';
                if (!upstreamHttpReachable && upstreamProbe.error) {
                    proxyError = upstreamProbe.error;
                }
            }
        } else {
            proxyStatus = 'configured';
            proxyNetworkStatus = 'unchecked';
        }
    }

    const recommendations: string[] = [];
    if (runtime.config.useProxy && proxyProbe && !proxyProbe.reachable) {
        recommendations.push(
            `Configured proxy (${maskProxyUrl(effectiveProxyServer)}) is not reachable on local TCP port (${proxyProbe.error ?? 'connection failed'}). Start your local proxy or set PROXY_URL=direct for domestic-only mode.`
        );
    } else if (runtime.config.useProxy && proxyStatus === 'unreachable' && networkChecked) {
        recommendations.push(
            `Configured proxy (${maskProxyUrl(effectiveProxyServer)}) accepted local TCP connection, but upstream requests failed (${proxyError ?? 'upstream unreachable'}). Check proxy credentials/protocol or upstream node.`
        );
    }
    const antibotBlockedEngines = engines.filter((e) => e.status === 'blocked_by_antibot').map((e) => e.engine);
    if (antibotBlockedEngines.length > 0) {
        recommendations.push(
            `Upstream anti-bot challenge detected on ${antibotBlockedEngines.join(', ')} (TCP/HTTP connected, application layer challenged). Consider switching proxy node or using browser/alternative engines.`
        );
    }
    if (!browserInfo.available) {
        if (browserInfo.mode === 'cdp') {
            recommendations.push(
                `Configured Playwright CDP endpoint (${browserInfo.target}) is not reachable (${browserInfo.error ?? 'connection failed'}). Start the remote browser or unset PLAYWRIGHT_CDP_ENDPOINT to use a local browser.`
            );
        } else if (browserInfo.mode === 'executable' && browserChecked) {
            recommendations.push(
                `Browser executable (${browserInfo.target}) failed to launch or open a test page (${browserInfo.error ?? 'launch failed'}). Verify browser installation, permissions, or proxy parameters.`
            );
        } else {
            recommendations.push(
                'No local Chromium/Edge/Chrome browser was detected. Install Edge/Chrome or set PLAYWRIGHT_EXECUTABLE_PATH for browser-rendered search and anti-bot fallback.'
            );
        }
    }
    if (!hasExaApiKey && (runtime.config.defaultSearchEngine === 'exa' || allowedList.includes('exa'))) {
        recommendations.push(
            'EXA_API_KEY is not configured; the exa engine cannot be used until EXA_API_KEY is set.'
        );
    }
    if (!env.CONTEXT7_API_KEY?.trim()) {
        recommendations.push(
            'CONTEXT7_API_KEY is not configured; resolveLibraryId/queryDocs will run on anonymous public quota.'
        );
    }

    const networkNotice = networkChecked
        ? 'Live network probes sent to target engines (using minimal result count and short-TTL cache). Avoid high-frequency execution to prevent upstream anti-bot rate limits.'
        : undefined;

    return {
        version,
        checkedAt,
        networkChecked,
        browserChecked,
        ...(networkNotice ? { networkNotice } : {}),
        ...(networkChecked
            ? {
                probeUserAgent: BROWSER_USER_AGENT,
                cachePolicy: {
                    okTtlMs: okCacheTtlMs,
                    challengeTtlMs: challengeCacheTtlMs,
                    failureTtlMs: failureCacheTtlMs
                }
            }
            : {}),
        probedEngines,
        configSources: {
            appConfigFile: {
                path: sanitizePathForLog(appConfigPath),
                exists: fs.existsSync(appConfigPath)
            },
            projectConfigFile: {
                path: sanitizePathForLog(projectConfigPath),
                exists: fs.existsSync(projectConfigPath)
            },
            dotEnvFile: {
                path: sanitizePathForLog(dotEnvPath),
                exists: fs.existsSync(dotEnvPath)
            },
            envOverrides,
            keySources
        },
        effectiveConfig: {
            defaultSearchEngine: runtime.config.defaultSearchEngine,
            allowedSearchEngines: runtime.config.allowedSearchEngines,
            searchMode: runtime.config.searchMode,
            useProxy: runtime.config.useProxy,
            proxyUrl: maskProxyUrl(runtime.config.proxyUrl),
            proxyEngines: runtime.config.proxyEngines,
            searchDeadlineMs: runtime.config.searchDeadlineMs,
            enableHttpServer: runtime.config.enableHttpServer,
            enableCors: Boolean(runtime.config.enableCors),
            corsOrigin: runtime.config.corsOrigin ?? '*',
            apiKeys: {
                context7: maskSecret(env.CONTEXT7_API_KEY),
                exa: maskSecret(env.EXA_API_KEY),
                brave: maskSecret(env.BRAVE_API_KEY),
                github: maskSecret(env.GITHUB_TOKEN || env.GH_TOKEN)
            }
        },
        proxy: {
            enabled: runtime.config.useProxy,
            server: maskProxyUrl(effectiveProxyServer),
            status: proxyStatus,
            networkStatus: proxyNetworkStatus,
            tcpReachable: proxyProbe ? proxyProbe.reachable : null,
            reachable: proxyStatus === 'disabled'
                ? null
                : proxyStatus === 'unreachable'
                    ? false
                    : true,
            latencyMs: proxyProbe ? proxyProbe.latencyMs : null,
            error: proxyError,
            bypassRules: runtime.config.useProxy ? getProxyBypassRules(runtime.config) : []
        },
        browser: browserInfo,
        engines,
        recommendations,
        ...(options.resetHealth ? { healthReset: true } : {})
    };
}

export function formatDoctorHumanReadable(report: DoctorReport): string {
    const proxyDesc = !report.proxy.enabled
        ? 'disabled'
        : report.proxy.status === 'configured'
            ? `local TCP open (${report.proxy.latencyMs}ms), upstream unchecked (use --network to probe)`
            : report.proxy.status === 'reachable'
                ? `reachable (${report.proxy.latencyMs}ms)`
                : `unreachable (${report.proxy.error ?? 'failed'})`;

    const browserProbeKind = report.browser.probeKind ?? (report.browserChecked ? 'browser_launch' : 'config_only');
    const browserLaunchDesc = report.browserChecked
        ? `, probeKind=${browserProbeKind}, launched=${report.browser.launched ? 'yes' : 'no'}, pageOpened=${report.browser.pageOpened ? 'yes' : 'no'}${report.browser.latencyMs !== null ? ` (${report.browser.latencyMs}ms)` : ''}`
        : ` (probeKind=${browserProbeKind}; path check only; use --browser to verify launch)`;

    const lines = [
        `my-websearch doctor (v${report.version})`,
        `Checked at: ${report.checkedAt}`,
        ...(report.healthReset ? ['Health state reset: yes'] : []),
        ...(report.networkNotice ? [`Notice: ${report.networkNotice}`] : []),
        '',
        'Configuration sources:',
        `  App config:     ${report.configSources.appConfigFile.path} (${report.configSources.appConfigFile.exists ? 'found' : 'missing'})`,
        `  Project config: ${report.configSources.projectConfigFile.path} (${report.configSources.projectConfigFile.exists ? 'found' : 'missing'})`,
        `  .env file:      ${report.configSources.dotEnvFile.path} (${report.configSources.dotEnvFile.exists ? 'found' : 'missing'})`,
        `  Process env:    ${report.configSources.envOverrides.length > 0 ? report.configSources.envOverrides.join(', ') : '(none)'}`,
        '',
        'Effective configuration:',
        `  Default engine:  ${report.effectiveConfig.defaultSearchEngine}`,
        `  Allowed engines: ${report.effectiveConfig.allowedSearchEngines.length > 0 ? report.effectiveConfig.allowedSearchEngines.join(', ') : '(all)'}`,
        `  Search mode:     ${report.effectiveConfig.searchMode}`,
        `  Search deadline: ${report.effectiveConfig.searchDeadlineMs}ms`,
        `  HTTP CORS:       ${report.effectiveConfig.enableCors ? `enabled (${report.effectiveConfig.corsOrigin})` : 'disabled'}`,
        `  API keys:        context7=${report.effectiveConfig.apiKeys.context7 ?? 'unset'}, exa=${report.effectiveConfig.apiKeys.exa ?? 'unset'}, brave=${report.effectiveConfig.apiKeys.brave ?? 'unset'}, github=${report.effectiveConfig.apiKeys.github ?? 'unset'}`,
        '',
        'Proxy:',
        `  Enabled:         ${report.proxy.enabled ? 'yes' : 'no'}`,
        `  Server:          ${report.proxy.server || '(none)'}`,
        `  Status:          ${proxyDesc}`,
        `  Proxy engines:   ${report.effectiveConfig.proxyEngines.length > 0 ? report.effectiveConfig.proxyEngines.join(', ') : report.proxy.enabled ? '(all)' : '(none)'}`,
        '',
        'Browser:',
        `  Available:       ${report.browser.available ? 'yes' : 'no'} (${report.browser.status}${browserLaunchDesc})`,
        `  Mode:            ${report.browser.mode}`,
        `  Target:          ${report.browser.target || '(none)'}`,
        ...(report.browser.error ? [`  Error:           ${report.browser.error}`] : []),
        '',
        `Engines (network=${report.networkChecked ? `checked [${report.probedEngines.join(', ') || 'none'}]` : 'unchecked'}):`
    ];

    for (const eng of report.engines) {
        const extra = eng.detail ? ` (${eng.detail})` : '';
        const cacheInfo = eng.probeKind === 'http_search'
            ? ` probe=${eng.probeKind} cached=${eng.cached ? 'yes' : 'no'} ttl=${eng.ttlMs}ms`
            : ` probe=${eng.probeKind}`;
        lines.push(
            `  - ${eng.engine.padEnd(11)} status=${eng.status.padEnd(21)} stage=${eng.stage.padEnd(14)} proxyTcp=${eng.proxyTcp.padEnd(11)} http=${eng.http.padEnd(11)} app=${eng.application.padEnd(15)} route=${eng.usesProxy ? 'proxy' : 'direct'}${cacheInfo}${extra}`
        );
    }

    if (report.recommendations.length > 0) {
        lines.push('');
        lines.push('Recommendations:');
        for (const rec of report.recommendations) {
            lines.push(`  * ${rec}`);
        }
    }

    return lines.join('\n');
}

