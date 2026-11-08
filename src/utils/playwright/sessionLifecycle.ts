import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../../config.js';
import {
    LocalBrowserSession,
    LocalBrowserSessionMode,
    PlaywrightModule
} from './types.js';
import {
    buildLocalBrowserProcessArgs,
    buildPlaywrightProxy,
    findFreePort,
    getLocalBrowserExecutablePath
} from './browserDiscovery.js';
import {
    createForceKill,
    readBrowserDomainMetadata,
    shouldTrackLocalBrowserSessionClients,
    unregisterLocalBrowserSessionClient,
    writeBrowserDomainMetadata
} from './domainLock.js';
import {
    processCommandLineCache,
    resolveLaunchFailureBrowserPid
} from './candidateDiscovery.js';
import { removeTempDirInBackground } from './browserSessionTemp.js';
import {
    closeConnectedCdpBrowser,
    connectLaunchedLocalBrowserSession,
    waitForBrowserReadyViaStdout
} from './cdpReadiness.js';

export * from './cdpReadiness.js';

export function detachLaunchedChildProcess(child: ChildProcess): void {
    try {
        child.stdout?.destroy?.();
    } catch {
        // Ignore stream cleanup errors.
    }
    try {
        child.stderr?.destroy?.();
    } catch {
        // Ignore stream cleanup errors.
    }
    try {
        child.unref?.();
    } catch {
        // Ignore unref errors.
    }
}

export async function launchStandardLocalBrowser(playwright: PlaywrightModule, sessionKey: string, domainKey: string, headless: boolean, launchArgs: string[]): Promise<LocalBrowserSession> {
    if (process.platform === 'win32') {
        const browserPath = getLocalBrowserExecutablePath();
        const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-search-'));
        const port = await findFreePort();
        const args = buildLocalBrowserProcessArgs(port, tempDir, launchArgs, headless);
        const sessionMode: LocalBrowserSessionMode = headless ? 'headless' : 'headed';

        const child = spawn(browserPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        });
        if (child.pid) {
            processCommandLineCache.set(child.pid, [browserPath, ...args].join(' '));
        }

        try {
            await waitForBrowserReadyViaStdout({ type: 'child', child });
        } catch (error) {
            detachLaunchedChildProcess(child);
            createForceKill(await resolveLaunchFailureBrowserPid(child.pid, tempDir, port, error), tempDir, undefined, domainKey)();
            throw error;
        }

        detachLaunchedChildProcess(child);

        const endpoint = `http://127.0.0.1:${port}`;
        let browserPid = child.pid;
        try {
            const connectedSession = await connectLaunchedLocalBrowserSession(
                playwright,
                endpoint,
                child.pid,
                tempDir,
                port,
                'Local browser launch'
            );
            browserPid = connectedSession.browserPid;
            const browser = connectedSession.browser;
            writeBrowserDomainMetadata({
                domainKey,
                sessionMode,
                browserPid,
                debugPort: port,
                tempDir,
                clientPids: shouldTrackLocalBrowserSessionClients(sessionMode) ? [process.pid] : []
            });
            const forceKill = createForceKill(browserPid, tempDir, browser, domainKey);
            const session: LocalBrowserSession = {
                browser, sessionKey, domainKey, sessionMode,
                browserPid, debugPort: port, tempDir,
                closeBrowser: async () => { await closeLocalBrowserSession(session); },
                forceKill
            };
            return session;
        } catch (error) {
            createForceKill(await resolveLaunchFailureBrowserPid(browserPid, tempDir, port, error), tempDir, undefined, domainKey)();
            throw error;
        }
    }

    const browser = await playwright.chromium.launch({
        headless,
        proxy: buildPlaywrightProxy(),
        args: launchArgs,
        executablePath: config.playwrightExecutablePath || getLocalBrowserExecutablePath()
    });

    const forceKill = createForceKill(undefined, undefined, browser);
    const session: LocalBrowserSession = {
        browser,
        sessionKey,
        domainKey,
        sessionMode: headless ? 'headless' : 'headed',
        closeBrowser: async () => {
            await closeLocalBrowserSession(session);
        },
        forceKill
    };
    return session;
}

export async function closeLocalBrowserSession(session: LocalBrowserSession): Promise<void> {
    if (session.browserPid && session.tempDir && session.domainKey) {
        if (session.sessionMode === 'headed') {
            try {
                await closeConnectedCdpBrowser(session.browser);
            } catch {
                // 释放 headed 复用连接失败不影响浏览器继续由 metadata 复用。
            }
            return;
        }

        const domainLock = { release: () => undefined };

        try {
            const metadata = readBrowserDomainMetadata(session.domainKey);
            const updatedMetadata = metadata
                ? unregisterLocalBrowserSessionClient(metadata)
                : null;
            const hasOtherClients = (updatedMetadata?.clientPids.length ?? 0) > 0;

            if (!hasOtherClients) {
                let timer: NodeJS.Timeout | undefined;
                try {
                    await Promise.race([
                        session.browser.close(),
                        new Promise((resolve) => {
                            timer = setTimeout(resolve, 3000);
                            if (typeof timer === 'object' && 'unref' in timer) {
                                (timer as NodeJS.Timeout).unref();
                            }
                        })
                    ]);
                } catch {
                    // Ignore close errors.
                } finally {
                    if (timer) {
                        clearTimeout(timer);
                    }
                }
                session.forceKill();
            } else {
                try {
                    await closeConnectedCdpBrowser(session.browser);
                } catch {
                    // 断开当前连接失败时不影响其他客户端继续复用浏览器。
                }
            }
        } finally {
            domainLock.release();
        }
        return;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            session.browser.close(),
            new Promise((resolve) => {
                timer = setTimeout(resolve, 5000);
                if (typeof timer === 'object' && 'unref' in timer) {
                    (timer as NodeJS.Timeout).unref();
                }
            })
        ]);
    } catch {
        session.forceKill();
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }

    if (session.tempDir) {
        // [P0 修复] 异步删除，避免 rmSync 递归删除 profile 冻结事件循环（实测最高 52.9s）
        removeTempDirInBackground(session.tempDir);
    }
}
