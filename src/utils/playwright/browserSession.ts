import { config } from '../../config.js';
import { acquireNativeFileLock } from '../nativeInterop.js';
import {
    LocalBrowserSession,
    LocalBrowserSessionMetadata,
    LocalBrowserSessionMode,
    OpenPlaywrightBrowserOptions,
    PlaywrightBrowserLike,
    PlaywrightBrowserSession,
    PlaywrightModule
} from './types.js';
import {
    loadPlaywrightClient
} from './browserDiscovery.js';
import {
    buildBrowserDomainKey,
    clearBrowserDomainMetadata,
    createForceKill,
    getBrowserDomainLockFilePath,
    readBrowserDomainMetadata,
    shouldTrackLocalBrowserSessionClients,
    trackLocalBrowserSessionClientForReuse,
    writeBrowserDomainMetadata
} from './domainLock.js';
import {
    resolveLocalBrowserCandidate
} from './candidateDiscovery.js';
import {
    cleanupStaleLocalBrowserSessions,
    removeTempDirInBackground,
    setActiveSessionTempDirGetter
} from './profileStore.js';
import {
    PLAYWRIGHT_CONNECT_TIMEOUT_MS,
    closeLocalBrowserSession,
    launchHiddenDesktopBrowser,
    launchStandardLocalBrowser,
    probeLocalCdpReadiness
} from './sessionLifecycle.js';
import { closeAllCDPSessions } from '../browser/cdpDriver.js';

// Re-exports for backward compatibility
export * from './browserSessionTemp.js';
export * from './browserDiscovery.js';
export * from './domainLock.js';
export * from './candidateDiscovery.js';
export * from './profileStore.js';
export * from './sessionLifecycle.js';

let cachedLocalBrowserSession: LocalBrowserSession | null = null;
let localBrowserSessionPromise: Promise<LocalBrowserSession> | null = null;
let cachedLocalBrowserSessionKey: string | null = null;
let cachedLocalBrowserSessionOptions: {
    headless: boolean;
    launchArgs: string[];
    options?: OpenPlaywrightBrowserOptions;
} | null = null;
let localBrowserSessionRefCount = 0;
let cleanupRegistered = false;

setActiveSessionTempDirGetter(() => cachedLocalBrowserSession?.tempDir);

function buildLocalSessionKey(headless: boolean, launchArgs: string[], options?: OpenPlaywrightBrowserOptions): string {
    return JSON.stringify({
        headless,
        hideWindow: options?.hideWindow === true,
        executablePath: config.playwrightExecutablePath || '',
        launchArgs
    });
}

export function getLocalBrowserSessionMode(headless: boolean, options?: OpenPlaywrightBrowserOptions): LocalBrowserSessionMode {
    if (options?.hideWindow) {
        return 'hidden-headed';
    }

    return headless ? 'headless' : 'headed';
}

export async function recoverLocalBrowserSessionBrowser(browser: PlaywrightBrowserLike | unknown): Promise<PlaywrightBrowserLike | null> {
    if (config.playwrightCdpEndpoint) {
        return null;
    }

    if (!cachedLocalBrowserSession || cachedLocalBrowserSession.browser !== browser || !cachedLocalBrowserSessionOptions) {
        return null;
    }

    const playwright = await loadPlaywrightClient();
    if (!playwright) {
        return null;
    }

    cachedLocalBrowserSession = null;
    cachedLocalBrowserSessionKey = null;

    const recoveredSession = await getOrCreateLocalBrowserSession(
        playwright,
        cachedLocalBrowserSessionOptions.headless,
        cachedLocalBrowserSessionOptions.launchArgs,
        cachedLocalBrowserSessionOptions.options
    );
    return recoveredSession.browser;
}

async function tryReusePersistedLocalBrowserSession(
    playwright: PlaywrightModule,
    domainKey: string,
    sessionKey: string
): Promise<LocalBrowserSession | null> {
    const metadata = readBrowserDomainMetadata(domainKey);
    if (!metadata) return null;

    const reusableBrowserCandidate = await resolveLocalBrowserCandidate(metadata.browserPid, metadata.tempDir, metadata.debugPort);
    if (!reusableBrowserCandidate) {
        clearBrowserDomainMetadata(domainKey, metadata.tempDir);
        removeTempDirInBackground(metadata.tempDir);
        return null;
    }

    const reusableBrowserPid = reusableBrowserCandidate.pid;
    const reusableDebugPort = metadata.debugPort ?? reusableBrowserCandidate.debugPort;

    const endpoint = `http://127.0.0.1:${reusableDebugPort}`;
    let browser: PlaywrightBrowserLike;
    try {
        browser = await probeLocalCdpReadiness(playwright, endpoint, 2000);
    } catch {
        console.error(`🧹 Persisted browser session (PID ${reusableBrowserPid}, port ${reusableDebugPort}) is no longer reachable, cleaning up`);
        createForceKill(reusableBrowserPid, metadata.tempDir, undefined, domainKey)();
        return null;
    }

    const metadataWithVerifiedPid: LocalBrowserSessionMetadata = {
        ...metadata,
        browserPid: reusableBrowserPid,
        debugPort: reusableDebugPort
    };
    const updatedMetadata = trackLocalBrowserSessionClientForReuse(metadataWithVerifiedPid);
    if (!shouldTrackLocalBrowserSessionClients(updatedMetadata.sessionMode)
        && (metadata.browserPid !== reusableBrowserPid || metadata.debugPort !== reusableDebugPort)) {
        writeBrowserDomainMetadata(updatedMetadata);
    }
    const forceKill = createForceKill(reusableBrowserPid, metadata.tempDir, browser, domainKey);
    const session: LocalBrowserSession = {
        browser,
        sessionKey,
        domainKey,
        sessionMode: updatedMetadata.sessionMode,
        browserPid: updatedMetadata.browserPid,
        debugPort: updatedMetadata.debugPort,
        tempDir: updatedMetadata.tempDir,
        closeBrowser: async () => {
            await closeLocalBrowserSession(session);
        },
        forceKill
    };
    console.error(`🧭 Reused existing Playwright browser session from PID ${reusableBrowserPid}`);
    return session;
}

function registerLocalBrowserCleanup(): void {
    if (cleanupRegistered) {
        return;
    }

    cleanupRegistered = true;
    process.once('exit', () => {
        if (cachedLocalBrowserSession) {
            cachedLocalBrowserSession = null;
            cachedLocalBrowserSessionKey = null;
        }
    });

    const handleSignalCleanup = async () => {
        if (cachedLocalBrowserSession) {
            await closeLocalBrowserSession(cachedLocalBrowserSession);
            cachedLocalBrowserSession = null;
            cachedLocalBrowserSessionKey = null;
        }
        process.exit();
    };

    process.once('SIGINT', handleSignalCleanup);
    process.once('SIGTERM', handleSignalCleanup);

    for (const signal of ['SIGBREAK', 'SIGHUP'] as NodeJS.Signals[]) {
        try {
            process.once(signal, handleSignalCleanup);
        } catch {
            // Signal is not supported on this platform/runtime.
        }
    }
}

async function destroyCachedLocalBrowserSession(): Promise<void> {
    if (localBrowserSessionRefCount > 0) {
        return;
    }

    if (localBrowserSessionPromise) {
        const inFlightPromise = localBrowserSessionPromise;
        localBrowserSessionPromise = null;
        try {
            const session = await inFlightPromise;
            await closeLocalBrowserSession(session);
        } catch {
            // Ignore launch/close errors during reset.
        }
    } else if (cachedLocalBrowserSession) {
        await closeLocalBrowserSession(cachedLocalBrowserSession);
    }

    cachedLocalBrowserSession = null;
    cachedLocalBrowserSessionKey = null;
    cachedLocalBrowserSessionOptions = null;
}

export async function shutdownLocalPlaywrightBrowserSessions(): Promise<void> {
    localBrowserSessionRefCount = 0;
    if (cachedLocalBrowserSession) {
        try {
            await closeLocalBrowserSession(cachedLocalBrowserSession);
        } finally {
            cachedLocalBrowserSession = null;
            cachedLocalBrowserSessionKey = null;
            cachedLocalBrowserSessionOptions = null;
        }
    }
    await closeAllCDPSessions().catch(() => undefined);
}

export async function getOrCreateLocalBrowserSession(
    playwright: PlaywrightModule,
    headless: boolean,
    launchArgs: string[],
    options?: OpenPlaywrightBrowserOptions
): Promise<LocalBrowserSession> {
    await cleanupStaleLocalBrowserSessions();

    const sessionKey = buildLocalSessionKey(headless, launchArgs, options);
    const sessionMode = getLocalBrowserSessionMode(headless, options);
    cachedLocalBrowserSessionOptions = {
        headless,
        launchArgs,
        options
    };

    if (cachedLocalBrowserSession && cachedLocalBrowserSessionKey === sessionKey) {
        try {
            await cachedLocalBrowserSession.browser.version();
            return cachedLocalBrowserSession;
        } catch {
            cachedLocalBrowserSession = null;
            cachedLocalBrowserSessionKey = null;
        }
    }

    if (localBrowserSessionPromise && cachedLocalBrowserSessionKey === sessionKey) {
        return localBrowserSessionPromise;
    }

    if (cachedLocalBrowserSession || localBrowserSessionPromise) {
        await destroyCachedLocalBrowserSession();
    }

    cachedLocalBrowserSessionKey = sessionKey;
    localBrowserSessionPromise = (async () => {
        const domainKey = buildBrowserDomainKey(sessionMode);
        const domainLockPath = getBrowserDomainLockFilePath(domainKey);
        const domainLock = acquireNativeFileLock(domainLockPath);
        let domainLockReleased = false;
        const releaseDomainLock = () => {
            if (domainLockReleased) {
                return;
            }
            domainLockReleased = true;
            domainLock.release();
        };

        try {
            const reusedSession = await tryReusePersistedLocalBrowserSession(playwright, domainKey, sessionKey);
            if (reusedSession) {
                releaseDomainLock();
                cachedLocalBrowserSession = reusedSession;
                registerLocalBrowserCleanup();
                return reusedSession;
            }

            if (sessionMode === 'headless') {
                const hiddenHeadedDomainKey = buildBrowserDomainKey('hidden-headed');
                const hiddenHeadedLockPath = getBrowserDomainLockFilePath(hiddenHeadedDomainKey);
                const hiddenHeadedLock = acquireNativeFileLock(hiddenHeadedLockPath);
                let hiddenHeadedLockReleased = false;
                const releaseHiddenHeadedLock = () => {
                    if (hiddenHeadedLockReleased) {
                        return;
                    }
                    hiddenHeadedLockReleased = true;
                    hiddenHeadedLock.release();
                };
                try {
                    const hiddenHeadedSession = await tryReusePersistedLocalBrowserSession(playwright, hiddenHeadedDomainKey, sessionKey);
                    if (hiddenHeadedSession) {
                        releaseHiddenHeadedLock();
                        releaseDomainLock();
                        hiddenHeadedSession.sessionKey = sessionKey;
                        cachedLocalBrowserSession = hiddenHeadedSession;
                        registerLocalBrowserCleanup();
                        return hiddenHeadedSession;
                    }
                } finally {
                    releaseHiddenHeadedLock();
                }
            }

            const session = options?.hideWindow
                ? await launchHiddenDesktopBrowser(playwright, sessionKey, domainKey, launchArgs)
                : await launchStandardLocalBrowser(playwright, sessionKey, domainKey, headless, launchArgs);
            session.sessionKey = sessionKey;

            releaseDomainLock();

            cachedLocalBrowserSession = session;
            registerLocalBrowserCleanup();
            return session;
        } catch (error) {
            releaseDomainLock();
            throw error;
        }
    })().finally(() => {
        localBrowserSessionPromise = null;
    });

    return localBrowserSessionPromise;
}

export async function openPlaywrightBrowser(
    headless: boolean,
    launchArgs: string[] = [],
    options?: OpenPlaywrightBrowserOptions
): Promise<PlaywrightBrowserSession> {
    const playwright = await loadPlaywrightClient();
    if (!playwright) {
        throw new Error('Browser driver is not available. The default CDP driver needs a Chromium-based browser (Chrome/Edge/Chromium/Brave/Vivaldi/Opera) – install one and/or set CHROME_PATH / PLAYWRIGHT_EXECUTABLE_PATH, or connect a remote browser with PLAYWRIGHT_CDP_ENDPOINT. BROWSER_DRIVER=playwright additionally requires the playwright-core package. Firefox is not supported.');
    }

    if (config.playwrightCdpEndpoint) {
        const browser = await playwright.chromium.connectOverCDP(config.playwrightCdpEndpoint, {
            timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS
        });
        const release = async () => {
            await browser.close().catch(() => undefined);
        };
        return {
            browser,
            release
        };
    }

    const session = await getOrCreateLocalBrowserSession(playwright, headless, launchArgs, options);
    localBrowserSessionRefCount += 1;
    const release = async () => {
        localBrowserSessionRefCount = Math.max(0, localBrowserSessionRefCount - 1);
        return Promise.resolve();
    };

    return {
        browser: session.browser,
        release
    };
}
