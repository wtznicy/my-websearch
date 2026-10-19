import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConfig } from '../../../config.js';
import { sanitizePathForLog } from '../../../configLoader.js';
import {
    buildPlaywrightProxy,
    getLocalBrowserExecutablePath,
    loadPlaywrightClient
} from '../../../utils/playwright/browserDiscovery.js';
import { maskProxyUrl } from './proxy.js';
import { probeTcpEndpoint } from './network.js';
import { BrowserLaunchProbeResult } from '../types.js';

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

export async function evaluateBrowserDoctor(
    appConfig: AppConfig,
    options: {
        browserChecked: boolean;
        browserProbeTimeoutMs: number;
        proxyProbeTimeoutMs: number;
        env: NodeJS.ProcessEnv;
        browserProbeFn?: (
            appConfig: AppConfig,
            timeoutMs: number
        ) => Promise<BrowserLaunchProbeResult>;
    }
): Promise<BrowserLaunchProbeResult> {
    if (options.browserChecked) {
        const rawProbeBrowser = options.browserProbeFn
            ?? ((cfg: AppConfig, timeout: number) => probeBrowserLaunch(cfg, timeout, { env: options.env }));
        const probed = await rawProbeBrowser(appConfig, options.browserProbeTimeoutMs);
        return {
            probeKind: 'browser_launch',
            ...probed
        };
    }

    try {
        if (appConfig.playwrightCdpEndpoint) {
            const cdpTarget = maskProxyUrl(appConfig.playwrightCdpEndpoint);
            const cdpProbe = await probeTcpEndpoint(appConfig.playwrightCdpEndpoint, options.proxyProbeTimeoutMs);
            if (cdpProbe && cdpProbe.reachable) {
                return {
                    available: true,
                    status: 'reachable',
                    mode: 'cdp',
                    probeKind: 'cdp_tcp',
                    target: cdpTarget,
                    headless: appConfig.playwrightHeadless,
                    launched: false,
                    pageOpened: false,
                    latencyMs: cdpProbe.latencyMs,
                    error: null
                };
            }
            return {
                available: false,
                status: 'unreachable',
                mode: 'cdp',
                probeKind: 'cdp_tcp',
                target: cdpTarget,
                headless: appConfig.playwrightHeadless,
                launched: false,
                pageOpened: false,
                latencyMs: cdpProbe?.latencyMs ?? null,
                error: cdpProbe?.error ?? 'CDP endpoint is not reachable'
            };
        }

        const executablePath = (appConfig.playwrightExecutablePath && fs.existsSync(appConfig.playwrightExecutablePath))
            ? appConfig.playwrightExecutablePath
            : getLocalBrowserExecutablePath();
        return {
            available: true,
            status: 'configured',
            mode: 'executable',
            probeKind: 'config_only',
            target: sanitizeBrowserTargetForDoctor(executablePath),
            headless: appConfig.playwrightHeadless,
            launched: false,
            pageOpened: false,
            latencyMs: null,
            error: null
        };
    } catch (error) {
        return {
            available: false,
            status: 'unavailable',
            mode: 'unavailable',
            probeKind: 'config_only',
            target: '',
            headless: appConfig.playwrightHeadless,
            launched: false,
            pageOpened: false,
            latencyMs: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

