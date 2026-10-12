import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AppConfig, config, engineShouldUseProxy, getProxyUrl } from '../../config.js';
import { LoadPlaywrightClientOptions, PlaywrightModule } from './types.js';

const require = createRequire(import.meta.url);

let cachedBrowserPath: string | null = null;
let playwrightModulePromise: Promise<PlaywrightModule | null> | null = null;
let playwrightModuleSource: string | null = null;
let playwrightUnavailableMessage: string | null = null;
let hasEmittedPlaywrightUnavailableWarning = false;

export type PlaywrightProxyOptions = {
    server: string;
    bypass?: string;
    username?: string;
    password?: string;
};

export const LOOPBACK_BYPASS_RULES = ['<local>', 'localhost', '127.0.0.1', '[::1]'] as const;

/**
 * 各搜索引擎对应的主域名与通配子域名。
 * Chromium bypass 规则中 `*.juejin.cn` 仅匹配子域名而不匹配裸主域名 `juejin.cn`，
 * 因此主域名与子域名必须同时列出，确保 HTTP 层与浏览器层遵守同一套代理分流策略。
 */
export const ENGINE_PROXY_DOMAINS: Record<string, string[]> = {
    baidu: ['baidu.com', '*.baidu.com'],
    sogou: ['sogou.com', '*.sogou.com'],
    csdn: ['csdn.net', '*.csdn.net'],
    juejin: ['juejin.cn', '*.juejin.cn'],
    bing: ['bing.com', '*.bing.com'],
    startpage: ['startpage.com', '*.startpage.com'],
    duckduckgo: ['duckduckgo.com', '*.duckduckgo.com'],
    brave: ['brave.com', '*.brave.com'],
    exa: ['exa.ai', '*.exa.ai']
};

export const DOMESTIC_DIRECT_CONTENT_DOMAINS: string[] = [
    'zhihu.com', '*.zhihu.com',
    'bilibili.com', '*.bilibili.com',
    'qq.com', '*.qq.com',
    '163.com', '*.163.com'
];

/**
 * 统一计算当前配置下应绕过代理（直连）的域名规则列表。
 * 与 HTTP 层的 `engineShouldUseProxy(engine, cfg)` 共享同一判断逻辑。
 */
export function getProxyBypassRules(cfg: AppConfig = config): string[] {
    const bypassItems: string[] = [...LOOPBACK_BYPASS_RULES];

    if (cfg.proxyEngines.length > 0) {
        // 用户明确指定了 PROXY_ENGINES 白名单（如仅海外引擎走代理，或仅指定 bing 走代理）：
        // 所有非白名单内的引擎（含 bing、startpage、baidu、sogou、csdn、juejin 等）均在浏览器层直连
        for (const [engine, domains] of Object.entries(ENGINE_PROXY_DOMAINS)) {
            if (!engineShouldUseProxy(engine, cfg)) {
                bypassItems.push(...domains);
            }
        }
        if (!engineShouldUseProxy('bing', cfg) && cfg.bingBaseUrl) {
            try {
                const customBingHost = new URL(cfg.bingBaseUrl).hostname.toLowerCase();
                if (customBingHost && !customBingHost.endsWith('.bing.com') && customBingHost !== 'bing.com') {
                    bypassItems.push(customBingHost);
                }
            } catch {
                // ignore invalid custom bingBaseUrl
            }
        }
        // 国内常见内容抓取站点直连，避免被国外代理节点绕行导致慢或被反爬拦截
        bypassItems.push(...DOMESTIC_DIRECT_CONTENT_DOMAINS);
    }

    return [...new Set(bypassItems)];
}

/**
 * 将逗号或分号分隔的 bypass 列表转换为 Chromium 命令行 `--proxy-bypass-list` 所需的分号格式。
 */
export function formatChromiumProxyBypassList(bypass: string): string {
    return bypass
        .split(/[,;]+/)
        .map((rule) => rule.trim())
        .filter(Boolean)
        .join(';');
}

/**
 * 评估某个主机名（或 URL）是否命中给定的代理绕过（bypass）规则列表。
 * 严格按照 Chromium / Playwright 的规则语义：
 * - `*.example.com` 仅匹配子域名（如 `api.example.com`），不匹配主域名 `example.com`
 * - `example.com` 精确匹配主域名 `example.com`
 */
export function matchesProxyBypassRule(
    hostnameOrUrl: string,
    bypass: string | readonly string[],
    separator: ',' | ';' | 'auto' = 'auto'
): boolean {
    let host = hostnameOrUrl.trim().toLowerCase();
    if (host.includes('://')) {
        try {
            host = new URL(host).hostname.toLowerCase();
        } catch {
            return false;
        }
    }
    if (!host) {
        return false;
    }

    const rules: readonly string[] = typeof bypass === 'string'
        ? (separator === ','
            ? bypass.split(',')
            : separator === ';'
                ? bypass.split(';')
                : bypass.split(/[,;]+/))
        : bypass;

    const cleanHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

    for (const rawRule of rules) {
        const rule = rawRule.trim().toLowerCase();
        if (!rule) continue;

        if (rule === '<local>') {
            if (!cleanHost.includes('.') && !cleanHost.includes(':')) {
                return true;
            }
            continue;
        }

        const cleanRule = rule.startsWith('[') && rule.endsWith(']') ? rule.slice(1, -1) : rule;
        if (cleanRule.startsWith('*.')) {
            const suffix = cleanRule.slice(1); // ".example.com"
            if (cleanHost.endsWith(suffix) && cleanHost.length > suffix.length) {
                return true;
            }
        } else if (cleanHost === cleanRule) {
            return true;
        }
    }

    return false;
}

/**
 * 统一策略函数：判断指定目标主机或 URL 在当前配置下是否应当走代理。
 */
export function shouldHostUseProxy(hostnameOrUrl: string, cfg: AppConfig = config): boolean {
    if (!cfg.useProxy || !getProxyUrl(cfg)) {
        return false;
    }
    const rules = getProxyBypassRules(cfg);
    return !matchesProxyBypassRule(hostnameOrUrl, rules);
}

/**
 * 构造传给 Playwright `chromium.launch({ proxy })` 的代理配置。
 * 注意：Playwright API 按逗号 `,` 解析 `proxy.bypass`（而非分号 `;`），
 * 自建 Chromium 命令行启动时再通过 `formatChromiumProxyBypassList` 转为分号。
 */
export function buildPlaywrightProxy(cfg: AppConfig = config): PlaywrightProxyOptions | undefined {
    const proxyUrl = getProxyUrl(cfg);
    if (!proxyUrl) {
        return undefined;
    }

    try {
        const parsed = new URL(proxyUrl);
        const bypassItems = getProxyBypassRules(cfg);
        const bypass = bypassItems.join(',');

        return {
            server: `${parsed.protocol}//${parsed.host}`,
            ...(bypass ? { bypass } : {}),
            ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
            ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {})
        };
    } catch (error) {
        console.warn('Invalid proxy URL for Playwright, falling back without browser proxy:', error);
        return undefined;
    }
}

export function normalizeLoadedPlaywrightModule(loaded: unknown): PlaywrightModule | null {
    if (typeof loaded === 'object' && loaded !== null) {
        const obj = loaded as Record<string, unknown>;
        if (obj.chromium) {
            return loaded as PlaywrightModule;
        }
        if (typeof obj.default === 'object' && obj.default !== null) {
            const defaultObj = obj.default as Record<string, unknown>;
            if (defaultObj.chromium) {
                return obj.default as PlaywrightModule;
            }
        }
    }
    return null;
}

export function getLocalBrowserExecutablePath(): string {
    if (config.playwrightExecutablePath && existsSync(config.playwrightExecutablePath)) {
        return config.playwrightExecutablePath;
    }

    if (cachedBrowserPath) {
        return cachedBrowserPath;
    }

    const candidates: string[] = [];
    candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

    const pf86 = process.env['PROGRAMFILES(X86)'];
    const pf = process.env['PROGRAMFILES'];
    const localAppData = process.env['LOCALAPPDATA'];
    if (pf86) {
        candidates.push(`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`);
        candidates.push(`${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
    }
    if (pf) {
        candidates.push(`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
        candidates.push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`);
    }
    if (localAppData) {
        candidates.push(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`);
    }

    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');

    for (const candidate of [...new Set(candidates)]) {
        if (existsSync(candidate)) {
            cachedBrowserPath = candidate;
            return candidate;
        }
    }

    throw new Error('No Chromium-based browser executable was found. Configure PLAYWRIGHT_EXECUTABLE_PATH or install Edge/Chrome.');
}

export function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address && typeof address === 'object') {
                const { port } = address;
                server.close(() => resolve(port));
                return;
            }

            server.close(() => reject(new Error('Could not determine a free debugging port')));
        });
        server.on('error', reject);
    });
}

export function getPlaywrightModuleCandidates(): Array<{ label: string; specifier: string }> {
    const candidates: Array<{ label: string; specifier: string }> = [];
    const seenSpecifiers = new Set<string>();

    const pushCandidate = (label: string, specifier: string) => {
        if (seenSpecifiers.has(specifier)) {
            return;
        }
        seenSpecifiers.add(specifier);
        candidates.push({ label, specifier });
    };

    pushCandidate('playwright package', 'playwright');
    pushCandidate('playwright-core package', 'playwright-core');

    return candidates;
}

export function getPlaywrightModuleSource(): string | null {
    return playwrightModuleSource;
}

function emitPlaywrightUnavailableWarning(options?: LoadPlaywrightClientOptions): void {
    if (options?.silent || !playwrightUnavailableMessage || hasEmittedPlaywrightUnavailableWarning) {
        return;
    }

    hasEmittedPlaywrightUnavailableWarning = true;
    console.warn(playwrightUnavailableMessage);
}

export async function loadPlaywrightClient(options?: LoadPlaywrightClientOptions): Promise<PlaywrightModule | null> {
    if (!playwrightModulePromise) {
        playwrightModulePromise = (async () => {
            const attempts: string[] = [];

            for (const candidate of getPlaywrightModuleCandidates()) {
                try {
                    const loaded = require(candidate.specifier);
                    const normalized = normalizeLoadedPlaywrightModule(loaded);
                    if (!normalized) {
                        attempts.push(`${candidate.label}: loaded module does not expose chromium`);
                        continue;
                    }

                    playwrightModuleSource = candidate.label;
                    playwrightUnavailableMessage = null;
                    hasEmittedPlaywrightUnavailableWarning = false;
                    console.error(`🧭 Playwright client resolved from ${candidate.label}`);
                    return normalized;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    attempts.push(`${candidate.label}: ${message}`);
                }
            }

            playwrightUnavailableMessage = [
                'Playwright client is unavailable, falling back to HTTP-only behavior.',
                'Install `playwright` or `playwright-core`, or expose an existing client with PLAYWRIGHT_MODULE_PATH.',
                `Attempts: ${attempts.join(' | ')}`
            ].join(' ');
            return null;
        })();
    }

    const playwright = await playwrightModulePromise;
    if (!playwright) {
        emitPlaywrightUnavailableWarning(options);
    }
    return playwright;
}
