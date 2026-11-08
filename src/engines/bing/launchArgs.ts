import { config } from '../../config.js';
import { BROWSER_USER_AGENT } from './blockedPage.js';
import { getPlaywrightModuleSource, loadPlaywrightClient, openPlaywrightBrowser } from '../../utils/playwrightClient.js';

export const BROWSER_CONTEXT_OPTIONS = {
    userAgent: BROWSER_USER_AGENT,
    locale: 'zh-CN',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: 'light'
};

let playwrightAvailabilityPromise: Promise<boolean> | null = null;
let hasVerifiedPlaywrightAvailability = false;
export function shouldUseHiddenHeadedBingBrowser(): boolean {
    // 现代 Chromium 统一采用 --headless=new，不再默认拉起 Windows 隐藏桌面与 C++ 原生 FFI
    return false;
}

export function getEffectiveBingPlaywrightHeadless(): boolean {
    return config.playwrightHeadless;
}

export function buildDefaultBrowserLaunchArgs(hideWindow: boolean): string[] {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection'
    ];

    if (hideWindow) {
        args.push('--disable-extensions');
        args.push('--no-default-browser-check');
        args.push('--window-position=-32000,-32000');
        args.push('--window-size=1,1');
    }

    return args;
}

export function buildWindowsBrowserLaunchArgs(hideWindow: boolean): string[] {
    // 修复 Windows/Edge 有头浏览器连续提示“不受支持的命令行标志”的问题：Windows 路径使用 allowlist，避免把 Linux/root 或跨站安全绕过类参数带到用户可见浏览器窗口里。
    const args = [
        '--no-first-run'
    ];

    if (hideWindow) {
        args.push('--no-default-browser-check');
        args.push('--window-position=-32000,-32000');
        args.push('--window-size=1,1');
    }

    return args;
}

export function buildBrowserLaunchArgs(hideWindow: boolean, platform: NodeJS.Platform = process.platform): string[] {
    return platform === 'win32'
        ? buildWindowsBrowserLaunchArgs(hideWindow)
        : buildDefaultBrowserLaunchArgs(hideWindow);
}

export function __buildBingBrowserLaunchArgsForTests(hideWindow: boolean, platform?: NodeJS.Platform): string[] {
    return buildBrowserLaunchArgs(hideWindow, platform);
}

export async function isPlaywrightAvailable(): Promise<boolean> {
    if (hasVerifiedPlaywrightAvailability) {
        return true;
    }

    if (!playwrightAvailabilityPromise) {
        playwrightAvailabilityPromise = (async () => {
            const playwright = await loadPlaywrightClient({ silent: true });
            if (!playwright) {
                return false;
            }

            try {
                const effectiveHeadless = getEffectiveBingPlaywrightHeadless();
                const session = await openPlaywrightBrowser(
                    effectiveHeadless,
                    buildBrowserLaunchArgs(shouldUseHiddenHeadedBingBrowser()),
                    { hideWindow: shouldUseHiddenHeadedBingBrowser() }
                );
                await session.release();
                hasVerifiedPlaywrightAvailability = true;
                return true;
            } catch (error) {
                const playwrightModuleSource = getPlaywrightModuleSource();
                console.warn(`Playwright browser is unavailable${playwrightModuleSource ? ` via ${playwrightModuleSource}` : ''}, auto fallback will retry on the next blocked request:`, error);
                return false;
            }
        })().finally(() => {
            if (!hasVerifiedPlaywrightAvailability) {
                playwrightAvailabilityPromise = null;
            }
        });
    }

    return playwrightAvailabilityPromise;
}
