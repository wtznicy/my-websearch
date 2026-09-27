import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tryNativeFileLock } from '../nativeInterop.js';
import {
    AcquirePlaywrightPageOptions,
    BrowserPlaywrightPagePool,
    ExistingContextPageWindowBounds,
    PooledPlaywrightPageEntry,
    PooledPlaywrightPageSession
} from './types.js';
import {
    isRecoverableLocalBrowserSessionError,
    recoverLocalBrowserSessionBrowser
} from './browserSession.js';

const CROSS_PROCESS_POOL_LOCK_DIR = path.join(tmpdir(), 'my-websearch-page-pool-locks');
const browserPlaywrightPagePools = new WeakMap<any, Map<string, BrowserPlaywrightPagePool>>();

export async function getPlaywrightPageTargetId(page: any): Promise<string> {
    try {
        const context = typeof page?.context === 'function' ? page.context() : null;
        if (context && typeof context.newCDPSession === 'function') {
            const session = await context.newCDPSession(page);
            const info = await session.send('Target.getTargetInfo');
            const targetId = info?.targetInfo?.targetId;
            if (typeof targetId === 'string' && targetId.length > 0) {
                return targetId;
            }
        }
    } catch {}
    throw new Error('无法获取 CDP targetId，跨进程页面锁需要浏览器提供全局唯一的页面标识');
}

export function getPageLockFilePath(poolKey: string, pageTargetId: string): string {
    mkdirSync(CROSS_PROCESS_POOL_LOCK_DIR, { recursive: true });
    const keyHash = createHash('sha1').update(`${poolKey}:${pageTargetId}`).digest('hex');
    return path.join(CROSS_PROCESS_POOL_LOCK_DIR, `page-${keyHash}.lock`);
}

export function getBrowserPlaywrightPagePool(browser: any, options?: AcquirePlaywrightPageOptions): BrowserPlaywrightPagePool {
    let browserPools = browserPlaywrightPagePools.get(browser);
    if (!browserPools) {
        browserPools = new Map<string, BrowserPlaywrightPagePool>();
        browserPlaywrightPagePools.set(browser, browserPools);
    }

    const poolKey = options?.poolKey ?? 'default';
    let pool = browserPools.get(poolKey);
    if (pool) {
        return pool;
    }

    pool = {
        poolKey,
        sharedContext: null,
        entries: [],
        preparePage: options?.preparePage,
        contextOptions: options?.contextOptions,
        preferExistingContext: options?.preferExistingContext !== false,
        acquireLock: null
    };
    browserPools.set(poolKey, pool);
    return pool;
}

export async function withPoolAcquireLock<T>(pool: BrowserPlaywrightPagePool, operation: () => Promise<T>): Promise<T> {
    while (pool.acquireLock) {
        await pool.acquireLock;
    }

    let releaseLock!: () => void;
    pool.acquireLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
    });

    try {
        return await operation();
    } finally {
        pool.acquireLock = null;
        releaseLock();
    }
}

export function isPageClosed(page: any): boolean {
    try {
        return typeof page?.isClosed === 'function' ? page.isClosed() : false;
    } catch {
        return true;
    }
}

export async function getExistingContextPageWindowBounds(page: any): Promise<{ bounds: ExistingContextPageWindowBounds | null; unavailable: boolean }> {
    try {
        const context = typeof page?.context === 'function' ? page.context() : null;
        if (!context || typeof context.newCDPSession !== 'function') {
            return { bounds: null, unavailable: false };
        }

        const session = await context.newCDPSession(page);
        const windowForTarget = await session.send('Browser.getWindowForTarget');
        const boundsResult = await session.send('Browser.getWindowBounds', { windowId: windowForTarget.windowId });
        return {
            bounds: boundsResult?.bounds ?? null,
            unavailable: false
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            bounds: null,
            unavailable: /Browser\.getWindowForTarget\): Browser window not found/i.test(message)
        };
    }
}

export async function isPopupLikePlaywrightPage(page: any): Promise<boolean> {
    const { unavailable } = await getExistingContextPageWindowBounds(page);
    return unavailable;
}

export async function syncPoolWithReusableExistingContextPages(pool: BrowserPlaywrightPagePool, context: any): Promise<void> {
    if (typeof context?.pages !== 'function') {
        return;
    }

    const existingPages = context.pages();
    if (!Array.isArray(existingPages)) {
        return;
    }

    for (const page of existingPages) {
        if (isPageClosed(page) || pool.entries.some((entry) => entry.page === page)) {
            continue;
        }

        if (await isPopupLikePlaywrightPage(page)) {
            continue;
        }

        if (pool.entries.some((entry) => entry.page === page)) {
            continue;
        }

        const pageTargetId = await getPlaywrightPageTargetId(page);
        pool.entries.push({
            context,
            page,
            busy: false,
            prepared: false,
            pageTargetId,
            pageLock: null
        });
    }
}

export async function createPooledPlaywrightPageEntry(browser: any, pool: BrowserPlaywrightPagePool): Promise<PooledPlaywrightPageEntry> {
    if (pool.preferExistingContext && typeof browser.contexts === 'function') {
        const contexts = browser.contexts();
        if (Array.isArray(contexts) && contexts.length > 0 && typeof contexts[0].newPage === 'function') {
            const context = contexts[0];
            await syncPoolWithReusableExistingContextPages(pool, context);

            const page = await context.newPage();
            const pageTargetId = await getPlaywrightPageTargetId(page);
            const entry: PooledPlaywrightPageEntry = {
                context,
                page,
                busy: false,
                prepared: false,
                pageTargetId,
                pageLock: null
            };
            pool.entries.push(entry);
            return entry;
        }
    }

    if (typeof browser.newContext === 'function') {
        if (!pool.sharedContext) {
            pool.sharedContext = await browser.newContext(pool.contextOptions);
        }

        const page = await pool.sharedContext.newPage();
        const pageTargetId = await getPlaywrightPageTargetId(page);
        const entry: PooledPlaywrightPageEntry = {
            context: pool.sharedContext,
            page,
            busy: false,
            prepared: false,
            pageTargetId,
            pageLock: null
        };
        pool.entries.push(entry);
        return entry;
    }

    if (!pool.contextOptions && typeof browser.newPage === 'function') {
        const page = await browser.newPage();
        const pageTargetId = await getPlaywrightPageTargetId(page);
        const entry: PooledPlaywrightPageEntry = {
            context: null,
            page,
            busy: false,
            prepared: false,
            pageTargetId,
            pageLock: null
        };
        pool.entries.push(entry);
        return entry;
    }

    throw new Error('Connected Playwright browser does not support creating a pooled page');
}

export async function acquirePooledPlaywrightPageOnce(
    browser: any,
    options?: AcquirePlaywrightPageOptions
): Promise<PooledPlaywrightPageSession> {
    const pool = getBrowserPlaywrightPagePool(browser, options);

    const entry = await withPoolAcquireLock(pool, async () => {
        if (pool.preferExistingContext && typeof browser.contexts === 'function') {
            const contexts = browser.contexts();
            if (Array.isArray(contexts) && contexts.length > 0) {
                await syncPoolWithReusableExistingContextPages(pool, contexts[0]);
            }
        }

        pool.entries = pool.entries.filter((candidate) => !isPageClosed(candidate.page));

        let candidate: PooledPlaywrightPageEntry | null = null;
        for (const poolEntry of pool.entries) {
            if (poolEntry.busy) continue;

            const lockPath = getPageLockFilePath(pool.poolKey, poolEntry.pageTargetId);
            const lock = tryNativeFileLock(lockPath);
            if (lock) {
                poolEntry.pageLock = lock;
                candidate = poolEntry;
                break;
            }
        }

        while (!candidate) {
            const createdEntry = await createPooledPlaywrightPageEntry(browser, pool);
            const lockPath = getPageLockFilePath(pool.poolKey, createdEntry.pageTargetId);
            const lock = tryNativeFileLock(lockPath);
            if (lock) {
                createdEntry.pageLock = lock;
                candidate = createdEntry;
                break;
            }
        }

        candidate.busy = true;
        return candidate;
    });

    if (!entry.prepared) {
        try {
            if (pool.preparePage) {
                await pool.preparePage(entry.page);
            }
            entry.prepared = true;
        } catch (error) {
            if (isPageClosed(entry.page)) {
                entry.pageLock?.release();
                entry.pageLock = null;
                pool.entries = pool.entries.filter((candidate) => candidate !== entry);
            } else {
                entry.pageLock?.release();
                entry.pageLock = null;
                entry.busy = false;
            }
            throw error;
        }
    }

    const releasePage = async () => {
        if (isPageClosed(entry.page)) {
            entry.pageLock?.release();
            entry.pageLock = null;
            pool.entries = pool.entries.filter((candidate) => candidate !== entry);
            return;
        }

        entry.pageLock?.release();
        entry.pageLock = null;
        entry.busy = false;
    };

    return {
        context: entry.context,
        page: entry.page,
        releasePage
    };
}

export async function acquirePooledPlaywrightPage(
    browser: any,
    options?: AcquirePlaywrightPageOptions
): Promise<PooledPlaywrightPageSession> {
    try {
        return await acquirePooledPlaywrightPageOnce(browser, options);
    } catch (error) {
        if (!isRecoverableLocalBrowserSessionError(error)) {
            throw error;
        }

        const recoveredBrowser = await recoverLocalBrowserSessionBrowser(browser);
        if (!recoveredBrowser) {
            throw error;
        }

        return acquirePooledPlaywrightPageOnce(recoveredBrowser, options);
    }
}
