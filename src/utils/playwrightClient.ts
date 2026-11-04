/**
 * Browser client facade（默认 CDP 驱动；Playwright 仅为历史兼容层）。
 *
 * Re-exports components decomposed into focused modules under src/utils/playwright/:
 * - types.ts: shared type definitions and interfaces
 * - browserDiscovery.ts: executable discovery, port allocation, proxy setup, module loading
 * - sessionLifecycle.ts: process lifecycle and browser launch
 * - cdpReadiness.ts: CDP endpoint readiness checks
 * - domainLock.ts: cross-process domain session locks
 * - profileStore.ts: temporary profile directories and cleanup
 * - pagePool.ts: page pooling, target-id and lockfile synchronization
 * - candidateDiscovery.ts: local browser process discovery
 * - browserSessionTemp.ts: safe temp-directory checks
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
