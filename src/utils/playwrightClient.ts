/**
 * Playwright client facade.
 *
 * Re-exports components decomposed into focused modules under src/utils/playwright/:
 * - types.ts: Type definitions and interfaces
 * - browserDiscovery.ts: Binary executable discovery, port allocation, proxy setup, and module loading
 * - browserSession.ts: Process lifecycle, CDP readiness, domain session locks, and cleanup
 * - pagePool.ts: Page pooling, target ID retrieval, and lockfile synchronization
 */

export * from './playwright/types.js';

export {
    buildPlaywrightProxy,
    normalizeLoadedPlaywrightModule,
    getLocalBrowserExecutablePath,
    findFreePort,
    getPlaywrightModuleCandidates,
    getPlaywrightModuleSource,
    loadPlaywrightClient
} from './playwright/browserDiscovery.js';

export {
    PLAYWRIGHT_CONNECT_TIMEOUT_MS,
    PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS,
    PLAYWRIGHT_LOCAL_CDP_READINESS_INITIAL_PROBE_TIMEOUT_MS,
    PLAYWRIGHT_LOCAL_CDP_READINESS_POLL_INTERVAL_MS,
    isRecoverableLocalBrowserSessionError,
    recoverLocalBrowserSessionBrowser,
    getLocalBrowserSessionMode,
    closeLocalBrowserSession,
    shutdownLocalPlaywrightBrowserSessions,
    getOrCreateLocalBrowserSession,
    openPlaywrightBrowser
} from './playwright/browserSession.js';

export {
    getPlaywrightPageTargetId,
    getPageLockFilePath,
    getBrowserPlaywrightPagePool,
    acquirePooledPlaywrightPage
} from './playwright/pagePool.js';
