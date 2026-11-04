import { rmSync } from 'node:fs';
import { readdir as readdirAsync, rm as rmAsync, stat as statAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireNativeFileLock } from '../nativeInterop.js';
import { isSafeTempDir, removeTempDirInBackground } from './browserSessionTemp.js';
export { isSafeTempDir, removeTempDirInBackground } from './browserSessionTemp.js';
import {
    clearBrowserDomainMetadataFromPath,
    createForceKill,
    getBrowserDomainLockFilePathByHash,
    listBrowserDomainMetadataEntries,
    normalizeActiveClientPids,
    readBrowserDomainMetadataFromPath,
    readBrowserDomainMetadataTempDirFromPath,
    shouldTrackLocalBrowserSessionClients,
    writeBrowserDomainMetadata
} from './domainLock.js';
import {
    commandLineMatchesLocalBrowserCandidate,
    getProcessCommandLine,
    isProcessInspectionTimeoutError,
    resolveLocalBrowserCandidatePid
} from './candidateDiscovery.js';

export const STALE_BROWSER_CLEANUP_BUDGET_MS = 8000;

let staleBrowserCleanupPerformed = false;
let activeSessionTempDirGetter: (() => string | undefined) | null = null;

export function setActiveSessionTempDirGetter(getter: () => string | undefined): void {
    activeSessionTempDirGetter = getter;
}

export function isStaleBrowserCleanupPerformed(): boolean {
    return staleBrowserCleanupPerformed;
}

export async function doCleanupStaleLocalBrowserSessions(): Promise<void> {
    const entries = listBrowserDomainMetadataEntries();

    for (const { domainHash, metadataPath, sessionMode } of entries) {
        const domainLock = acquireNativeFileLock(getBrowserDomainLockFilePathByHash(domainHash));
        try {
            const metadata = readBrowserDomainMetadataFromPath(metadataPath, sessionMode);
            if (!metadata) {
                rmSync(metadataPath, { force: true });
                continue;
            }

            const activeClients = shouldTrackLocalBrowserSessionClients(metadata.sessionMode)
                ? normalizeActiveClientPids(metadata.clientPids.filter((pid) => pid !== process.pid))
                : [];

            // P0-3 & P1-9 快速路径：若客户端 PID 全部已死亡，快速校验 PID 命令行后强杀与清理（防 PID 复用误杀）
            if (shouldTrackLocalBrowserSessionClients(metadata.sessionMode) && activeClients.length === 0 && metadata.clientPids.length > 0) {
                let shouldKill = false;
                const pid = metadata.browserPid;
                if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
                    try {
                        const cmdLine = await getProcessCommandLine(pid);
                        if (cmdLine && (!metadata.tempDir || commandLineMatchesLocalBrowserCandidate(cmdLine, metadata.tempDir, metadata.debugPort))) {
                            shouldKill = true;
                        }
                    } catch {
                        // ignore inspection error
                    }
                }
                if (shouldKill) {
                    createForceKill(pid, metadata.tempDir)();
                } else if (metadata.tempDir && isSafeTempDir(metadata.tempDir)) {
                    removeTempDirInBackground(metadata.tempDir);
                }
                clearBrowserDomainMetadataFromPath(metadataPath, metadata.tempDir);
                continue;
            }

            const normalizedMetadata = shouldTrackLocalBrowserSessionClients(metadata.sessionMode)
                ? {
                    ...metadata,
                    clientPids: activeClients
                }
                : metadata;
            if (shouldTrackLocalBrowserSessionClients(normalizedMetadata.sessionMode)
                && normalizedMetadata.clientPids.length !== metadata.clientPids.length) {
                writeBrowserDomainMetadata(normalizedMetadata);
            }

            const browserCandidatePid = await resolveLocalBrowserCandidatePid(
                normalizedMetadata.browserPid,
                normalizedMetadata.tempDir,
                normalizedMetadata.debugPort
            );

            if (!browserCandidatePid) {
                createForceKill(normalizedMetadata.browserPid, normalizedMetadata.tempDir)();
                clearBrowserDomainMetadataFromPath(metadataPath, normalizedMetadata.tempDir);
            } else if (browserCandidatePid !== normalizedMetadata.browserPid) {
                writeBrowserDomainMetadata({
                    ...normalizedMetadata,
                    browserPid: browserCandidatePid
                });
            }
        } catch (error) {
            if (isProcessInspectionTimeoutError(error)) {
                throw error;
            }
        } finally {
            domainLock.release();
        }
    }
}

/**
 * 后台扫描并清理因历史进程崩溃、断电或异常终止遗留的孤儿浏览器临时目录（mcp-search-*）。
 * 异步执行，不占用主事件循环，不计入启动清理预算。
 */
export async function cleanOrphanTempProfilesInBackground(maxAgeMs = 60 * 60 * 1000, currentActiveTempDir?: string): Promise<void> {
    try {
        const tempRoot = tmpdir();
        const entries = await readdirAsync(tempRoot, { withFileTypes: true }).catch(() => []);
        const now = Date.now();

        // 收集当前活跃或复用中的 metadata tempDir，避免误删正在使用的目录
        const activeTempDirs = new Set(
            listBrowserDomainMetadataEntries()
                .map((e) => readBrowserDomainMetadataTempDirFromPath(e.metadataPath))
                .filter((d): d is string => typeof d === 'string' && d.length > 0)
        );
        const activeSessionDir = currentActiveTempDir ?? activeSessionTempDirGetter?.();
        if (activeSessionDir) {
            activeTempDirs.add(activeSessionDir);
        }

        const candidateEntries = entries.filter((entry) =>
            entry.isDirectory() && (entry.name.startsWith('mcp-search-') || entry.name.startsWith('my-websearch-cdp-'))
        );
        await Promise.all(candidateEntries.map(async (entry) => {
            const fullPath = path.join(tempRoot, entry.name);
            if (activeTempDirs.has(fullPath)) {
                return;
            }
            try {
                const stats = await statAsync(fullPath).catch(() => null);
                const isStale = stats && (
                    (now - stats.birthtimeMs > maxAgeMs) ||
                    (now - stats.mtimeMs > maxAgeMs)
                );
                if (isStale) {
                    await rmAsync(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
                }
            } catch {
                // 忽略单个目录检查异常
            }
        }));
    } catch {
        // 忽略后台扫描异常
    }
}

export async function cleanupStaleLocalBrowserSessions(currentActiveTempDir?: string): Promise<void> {
    if (staleBrowserCleanupPerformed) {
        return;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            doCleanupStaleLocalBrowserSessions(),
            new Promise<void>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Browser cleanup budget (${STALE_BROWSER_CLEANUP_BUDGET_MS}ms) exceeded`)), STALE_BROWSER_CLEANUP_BUDGET_MS);
                if (typeof timer === 'object' && 'unref' in timer) {
                    (timer as NodeJS.Timeout).unref();
                }
            })
        ]);
        staleBrowserCleanupPerformed = true;
        void cleanOrphanTempProfilesInBackground(undefined, currentActiveTempDir).catch(() => undefined);
    } catch (error) {
        console.warn('[browserSession] cleanupStaleLocalBrowserSessions exceeded budget or failed, proceeding with fresh launch:', error instanceof Error ? error.message : String(error));
        // 不阻断冷启动：允许下次有机会再重试清理
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
