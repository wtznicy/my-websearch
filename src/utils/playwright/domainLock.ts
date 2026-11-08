import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../../config.js';
import {
    BrowserDomainMetadataEntry,
    LocalBrowserSessionMetadata,
    LocalBrowserSessionMetadataFile,
    LocalBrowserSessionMode,
    PlaywrightBrowserLike
} from './types.js';
import { getLocalBrowserExecutablePath } from './browserDiscovery.js';
import { isSafeTempDir, removeTempDirInBackground } from './browserSessionTemp.js';
import {
    invalidateLocalBrowserCandidatesCache,
    processCommandLineCache,
    processExists
} from './candidateDiscovery.js';

export const LOCAL_BROWSER_DOMAIN_METADATA_PREFIX = 'domain-session-';
export const CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR = path.join(tmpdir(), 'my-websearch-browser-session-locks');

export function buildBrowserDomainKey(mode: LocalBrowserSessionMode): string {
    if (mode === 'headed') {
        const execPath = config.playwrightExecutablePath || getLocalBrowserExecutablePath();
        return `headed:${execPath}`;
    }
    return mode;
}

export function getBrowserDomainHash(domainKey: string): string {
    return createHash('sha1').update(domainKey).digest('hex');
}

export function getBrowserDomainLockFilePathByHash(domainHash: string): string {
    mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
    return path.join(
        CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR,
        `domain-${domainHash}.lock`
    );
}

export function getBrowserDomainLockFilePath(domainKey: string): string {
    return getBrowserDomainLockFilePathByHash(getBrowserDomainHash(domainKey));
}

export function getLocalBrowserSessionModeFromDomainKey(domainKey: string): LocalBrowserSessionMode {
    if (domainKey.startsWith('headed:')) {
        return 'headed';
    }

    if (domainKey === 'hidden-headed') {
        return 'hidden-headed';
    }

    if (domainKey === 'headless') {
        return 'headless';
    }

    throw new Error(`Unknown local browser domain key: ${domainKey}`);
}

export function getBrowserDomainMetadataPath(domainKey: string): string {
    mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
    const sessionMode = getLocalBrowserSessionModeFromDomainKey(domainKey);
    return path.join(
        CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR,
        `${LOCAL_BROWSER_DOMAIN_METADATA_PREFIX}${sessionMode}-${getBrowserDomainHash(domainKey)}.json`
    );
}

export function listBrowserDomainMetadataEntries(): BrowserDomainMetadataEntry[] {
    try {
        mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
        const metadataFilePattern = new RegExp(
            `^${LOCAL_BROWSER_DOMAIN_METADATA_PREFIX}(headed|headless|hidden-headed)-([a-f0-9]+)\\.json$`,
            'u'
        );
        return readdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR)
            .map((fileName) => {
                const match = fileName.match(metadataFilePattern);
                return match
                    ? {
                        sessionMode: match[1] as LocalBrowserSessionMode,
                        domainHash: match[2],
                        metadataPath: path.join(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, fileName)
                    }
                    : null;
            })
            .filter((entry): entry is BrowserDomainMetadataEntry => entry !== null);
    } catch {
        return [];
    }
}

export const BROWSER_METADATA_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

export function normalizeBrowserDomainMetadata(
    parsed: Partial<LocalBrowserSessionMetadataFile>,
    sessionMode: LocalBrowserSessionMode,
    metadataPath?: string,
    domainKey?: string
): LocalBrowserSessionMetadata | null {
    if (typeof parsed.tempDir !== 'string' || parsed.tempDir.length === 0) return null;

    return {
        domainKey,
        metadataPath,
        sessionMode,
        browserPid: Number.isInteger(parsed.browserPid) ? parsed.browserPid : undefined,
        debugPort: Number.isInteger(parsed.debugPort) ? parsed.debugPort : undefined,
        tempDir: parsed.tempDir,
        savedAt: typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : undefined,
        clientPids: shouldTrackLocalBrowserSessionClients(sessionMode) && Array.isArray(parsed.clientPids)
            ? parsed.clientPids.filter((pid): pid is number => Number.isInteger(pid) && pid > 0)
            : []
    };
}

export function readBrowserDomainMetadataFromPath(
    metadataPath: string,
    sessionMode: LocalBrowserSessionMode = 'hidden-headed',
    domainKey?: string
): LocalBrowserSessionMetadata | null {
    try {
        const raw = JSON.parse(readFileSync(metadataPath, 'utf8')) as Partial<LocalBrowserSessionMetadataFile>;
        const normalized = normalizeBrowserDomainMetadata(
            raw,
            sessionMode,
            metadataPath,
            domainKey
        );
        if (!normalized) {
            return null;
        }

        if (typeof normalized.savedAt === 'number' && Date.now() - normalized.savedAt > BROWSER_METADATA_MAX_AGE_MS) {
            // 超龄 metadata（> 12h）：必须先检查浏览器与客户端 PID 是否仍存活，区分三类情形：
            // 1) 长期活跃实例（浏览器存活 + 仍有存活使用者）：保留 profile 目录并刷新 savedAt；
            // 2) 孤儿浏览器进程（浏览器存活 + 所有客户端已退出）：通过 forceKill 终止孤儿浏览器并异步清理目录与记录；
            // 3) 过期死记录（浏览器已退出）：确认无存活使用者后异步删除目录并移除记录。
            const hasLiveBrowser = typeof normalized.browserPid === 'number' && processExists(normalized.browserPid);
            const trackClients = shouldTrackLocalBrowserSessionClients(sessionMode);
            const activeClientPids = trackClients ? normalizeActiveClientPids(normalized.clientPids) : [];
            const hasLiveClients = trackClients ? activeClientPids.length > 0 : hasLiveBrowser;

            if (hasLiveBrowser && hasLiveClients) {
                const refreshed: LocalBrowserSessionMetadata = {
                    ...normalized,
                    savedAt: Date.now(),
                    clientPids: activeClientPids
                };
                writeBrowserDomainMetadata(refreshed);
                return refreshed;
            }

            if (hasLiveBrowser && !hasLiveClients) {
                // 孤儿进程：终止残留浏览器并清理 profile 与 metadata
                createForceKill(normalized.browserPid, normalized.tempDir, undefined, domainKey)();
                clearBrowserDomainMetadataFromPath(metadataPath, normalized.tempDir);
                return null;
            }

            // 过期记录（浏览器已不存在）：仅在确认无存活客户端占用时清理目录
            if (!hasLiveClients && normalized.tempDir) {
                removeTempDirInBackground(normalized.tempDir, 0);
            }
            clearBrowserDomainMetadataFromPath(metadataPath, normalized.tempDir);
            return null;
        }

        return normalized;
    } catch {
        return null;
    }
}

export function readBrowserDomainMetadata(domainKey: string): LocalBrowserSessionMetadata | null {
    return readBrowserDomainMetadataFromPath(
        getBrowserDomainMetadataPath(domainKey),
        getLocalBrowserSessionModeFromDomainKey(domainKey),
        domainKey
    );
}

export function serializeBrowserDomainMetadata(metadata: LocalBrowserSessionMetadata): LocalBrowserSessionMetadataFile {
    const serializedMetadata: LocalBrowserSessionMetadataFile = {
        browserPid: metadata.browserPid,
        debugPort: metadata.debugPort,
        tempDir: metadata.tempDir,
        savedAt: metadata.savedAt ?? Date.now()
    };

    if (shouldTrackLocalBrowserSessionClients(metadata.sessionMode)) {
        serializedMetadata.clientPids = normalizeActiveClientPids(metadata.clientPids);
    }

    return serializedMetadata;
}

export function writeBrowserDomainMetadata(metadata: LocalBrowserSessionMetadata): void {
    const metadataPath = metadata.domainKey
        ? getBrowserDomainMetadataPath(metadata.domainKey)
        : metadata.metadataPath;
    if (!metadataPath) return;

    try {
        writeFileSync(
            metadataPath,
            JSON.stringify(serializeBrowserDomainMetadata(metadata), null, 2),
            { encoding: 'utf8', mode: 0o600 }
        );
    } catch {
        // metadata 写入失败只影响跨进程复用，当前进程仍然可以继续使用已连接的浏览器。
    }
}

export function readBrowserDomainMetadataTempDirFromPath(metadataPath: string): string | undefined {
    try {
        const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as Partial<LocalBrowserSessionMetadataFile>;
        return typeof parsed.tempDir === 'string' ? parsed.tempDir : undefined;
    } catch {
        return undefined;
    }
}

export function clearBrowserDomainMetadataFromPath(metadataPath: string, tempDir?: string): void {
    if (tempDir) {
        const currentTempDir = readBrowserDomainMetadataTempDirFromPath(metadataPath);
        if (currentTempDir && currentTempDir !== tempDir) {
            return;
        }
    }

    try {
        rmSync(metadataPath, { force: true });
    } catch {
        // Ignore metadata cleanup failures.
    }
}

export function clearBrowserDomainMetadata(domainKey: string, tempDir?: string): void {
    clearBrowserDomainMetadataFromPath(getBrowserDomainMetadataPath(domainKey), tempDir);
}

export function normalizeActiveClientPids(clientPids: number[]): number[] {
    return [...new Set(clientPids.filter((pid) => processExists(pid)))];
}

export function shouldTrackLocalBrowserSessionClients(sessionMode: LocalBrowserSessionMode): boolean {
    return sessionMode !== 'headed';
}

export function registerLocalBrowserSessionClient(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    if (!shouldTrackLocalBrowserSessionClients(metadata.sessionMode)) {
        return { ...metadata, clientPids: [] };
    }

    const normalizedMetadata: LocalBrowserSessionMetadata = {
        ...metadata,
        clientPids: normalizeActiveClientPids([...metadata.clientPids, pid])
    };
    writeBrowserDomainMetadata(normalizedMetadata);
    return normalizedMetadata;
}

export function unregisterLocalBrowserSessionClient(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    if (!shouldTrackLocalBrowserSessionClients(metadata.sessionMode)) {
        return { ...metadata, clientPids: [] };
    }

    const normalizedMetadata: LocalBrowserSessionMetadata = {
        ...metadata,
        clientPids: normalizeActiveClientPids(metadata.clientPids.filter((clientPid) => clientPid !== pid))
    };
    writeBrowserDomainMetadata(normalizedMetadata);
    return normalizedMetadata;
}

export function trackLocalBrowserSessionClientForReuse(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    if (!shouldTrackLocalBrowserSessionClients(metadata.sessionMode)) {
        return { ...metadata, clientPids: [] };
    }

    return registerLocalBrowserSessionClient(metadata, pid);
}

export function createForceKill(browserPid?: number, tempDir?: string, browser?: PlaywrightBrowserLike, domainKey?: string): () => void {
    return () => {
        try {
            browser?.disconnect?.();
        } catch {
            // Ignore disconnect errors.
        }

        if (Number.isInteger(browserPid) && browserPid! > 0 && browserPid !== process.pid && browserPid !== 4 && browserPid !== 1) {
            processCommandLineCache.delete(browserPid!);
            if (process.platform === 'win32') {
                try {
                    const child = spawn('taskkill', ['/F', '/T', '/PID', String(browserPid)], {
                        windowsHide: true,
                        stdio: 'ignore',
                        detached: true,
                        timeout: 3000
                    });
                    child.unref();
                } catch {
                    // Ignore kill errors.
                }
            } else {
                try {
                    process.kill(-browserPid!);
                } catch {
                    // Ignore group kill errors.
                }
                try {
                    process.kill(browserPid!);
                } catch {
                    // Ignore direct kill errors.
                }
            }
        }

        if (tempDir && isSafeTempDir(tempDir)) {
            invalidateLocalBrowserCandidatesCache(tempDir);
            try {
                if (domainKey) {
                    clearBrowserDomainMetadata(domainKey, tempDir);
                }
                // [P0 修复] 异步删除，避免 rmSync 递归删除 Chrome profile 冻结主事件循环
                // （实测僵死 profile 目录同步删除阻塞 52.9s，连带冻结所有并发请求与预算定时器）
                removeTempDirInBackground(tempDir);
            } catch {
                // Ignore cleanup errors.
            }
        }
    };
}
