import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readdir as readdirAsync, rm as rmAsync, stat as statAsync } from 'node:fs/promises';

/**
 * [P0 修复与增强] 异步删除浏览器 profile 临时目录。
 *
 * 背景：Chrome profile 目录含 Cache/LevelDB 等数千至数万个小文件，
 * 同步 rmSync(recursive) 会阻塞 Node 主事件循环——实测单个僵尸会话清理阻塞 52.9 秒
 * （空目录同期仅 78ms），期间整个 MCP server 冻结，所有并发请求连坐超时，且 JS 层预算定时器失效。
 *
 * 增强防御：
 * 1. 采用 fs/promises.rm 异步删除，避免主线程事件循环冻结。
 * 2. Windows 下进程 taskkill 后可能在毫秒级内仍持有文件句柄（如 LOCK/Cookies），
 *    立即删除容易触发 EBUSY/EPERM 导致删除失败残留（导致 %TEMP% 积累上 GB 孤儿目录）。
 *    因此配置 maxRetries: 5, retryDelay: 300，并在延时后执行，确保锁释放并成功清理。
 */
export function removeTempDirInBackground(tempDir: string | undefined, delayMs = 300): void {
    if (!tempDir) {
        return;
    }
    const execute = () => {
        void rmAsync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
    };
    if (delayMs > 0) {
        const timer = setTimeout(execute, delayMs);
        if (typeof timer === 'object' && 'unref' in timer) {
            timer.unref();
        }
    } else {
        execute();
    }
}

const execFileAsync = promisify(execFile);
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppConfig, config } from '../../config.js';
import {
    acquireNativeFileLock,
    closeHandle,
    launchProcessOnHiddenDesktopWithPipes,
    readNamedPipeAsync
} from '../nativeInterop.js';
import {
    BrowserDomainMetadataEntry,
    LocalBrowserProcessCandidate,
    LocalBrowserSession,
    LocalBrowserSessionMetadata,
    LocalBrowserSessionMetadataFile,
    LocalBrowserSessionMode,
    OpenPlaywrightBrowserOptions,
    PlaywrightBrowserLike,
    PlaywrightBrowserSession,
    PlaywrightModule
} from './types.js';
import {
    buildPlaywrightProxy,
    findFreePort,
    formatChromiumProxyBypassList,
    getLocalBrowserExecutablePath,
    loadPlaywrightClient
} from './browserDiscovery.js';

export const PLAYWRIGHT_CONNECT_TIMEOUT_MS = Math.max(config.playwrightNavigationTimeoutMs, 30000);
export const PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS = Math.max(config.playwrightNavigationTimeoutMs * 2, 60000);
export const PLAYWRIGHT_LOCAL_CDP_READINESS_INITIAL_PROBE_TIMEOUT_MS = 1000;
export const PLAYWRIGHT_LOCAL_CDP_READINESS_POLL_INTERVAL_MS = 1000;

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
let staleBrowserCleanupPerformed = false;

const LOCAL_BROWSER_DOMAIN_METADATA_PREFIX = 'domain-session-';
const CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR = path.join(tmpdir(), 'my-websearch-browser-session-locks');

const processCommandLineCache = new Map<number, string>();

interface CandidatesCacheEntry {
    timestamp: number;
    candidates: LocalBrowserProcessCandidate[];
}
const localBrowserCandidatesCache = new Map<string, CandidatesCacheEntry>();
const CANDIDATES_CACHE_TTL_MS = 2000;

export function isRecoverableLocalBrowserSessionError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('browser has been closed')
        || message.includes('target page, context or browser has been closed')
        || message.includes('connection closed')
        || message.includes('browser closed')
        || message.includes('not connected');
}

async function connectOverCdpOnly(
    playwright: PlaywrightModule,
    endpoint: string,
    timeout: number
): Promise<PlaywrightBrowserLike> {
    return playwright.chromium.connectOverCDP(endpoint, { timeout });
}

async function closeConnectedCdpBrowser(browser: PlaywrightBrowserLike | unknown, timeoutMs = 3000): Promise<void> {
    const browserCandidate = browser as PlaywrightBrowserLike | null | undefined;
    if (!browserCandidate || typeof browserCandidate.close !== 'function') {
        return;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            browserCandidate.close(),
            new Promise((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
                if (typeof timer === 'object' && 'unref' in timer) {
                    (timer as NodeJS.Timeout).unref();
                }
            })
        ]);
    } catch {
        // ignore
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

function detachLaunchedChildProcess(child: ChildProcess): void {
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

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function waitForTimeout(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            })
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function probeLocalCdpReadiness(
    playwright: PlaywrightModule,
    endpoint: string,
    probeTimeoutMs: number
): Promise<PlaywrightBrowserLike> {
    const browser = await connectOverCdpOnly(
        playwright,
        endpoint,
        probeTimeoutMs
    );

    try {
        await withOperationTimeout(
            Promise.resolve(browser.version ? browser.version() : ''),
            probeTimeoutMs,
            `Timed out while probing local browser CDP readiness after ${probeTimeoutMs}ms`
        );
        return browser;
    } catch (error) {
        await closeConnectedCdpBrowser(browser);
        throw error;
    }
}

async function connectOverCdpWhenReady(
    playwright: PlaywrightModule,
    endpoint: string
): Promise<PlaywrightBrowserLike> {
    const startedAt = Date.now();
    let lastError: unknown;
    let probeTimeoutMs = PLAYWRIGHT_LOCAL_CDP_READINESS_INITIAL_PROBE_TIMEOUT_MS;

    while (Date.now() - startedAt < PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS) {
        const remainingBeforeProbeMs = PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS - (Date.now() - startedAt);
        if (remainingBeforeProbeMs <= 0) {
            break;
        }

        const currentProbeTimeoutMs = Math.min(probeTimeoutMs, remainingBeforeProbeMs);
        try {
            return await probeLocalCdpReadiness(playwright, endpoint, currentProbeTimeoutMs);
        } catch (error) {
            lastError = error;
            probeTimeoutMs = Math.min(probeTimeoutMs * 2, PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS);
            const elapsedMs = Date.now() - startedAt;
            const remainingMs = PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS - elapsedMs;
            if (remainingMs <= 0) {
                break;
            }
            await waitForTimeout(Math.min(PLAYWRIGHT_LOCAL_CDP_READINESS_POLL_INTERVAL_MS, remainingMs));
        }
    }

    const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
    throw new Error(`Timed out while waiting for local browser CDP readiness after ${PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS}ms.${suffix}`);
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

export function getLocalBrowserSessionMode(headless: boolean, options?: OpenPlaywrightBrowserOptions): LocalBrowserSessionMode {
    if (options?.hideWindow) {
        return 'hidden-headed';
    }

    return headless ? 'headless' : 'headed';
}

function buildLocalSessionKey(headless: boolean, launchArgs: string[], options?: OpenPlaywrightBrowserOptions): string {
    return JSON.stringify({
        headless,
        hideWindow: options?.hideWindow === true,
        executablePath: config.playwrightExecutablePath || '',
        launchArgs
    });
}

function buildBrowserDomainKey(mode: LocalBrowserSessionMode): string {
    if (mode === 'headed') {
        const execPath = config.playwrightExecutablePath || getLocalBrowserExecutablePath();
        return `headed:${execPath}`;
    }
    return mode;
}

function getBrowserDomainHash(domainKey: string): string {
    return createHash('sha1').update(domainKey).digest('hex');
}

function getBrowserDomainLockFilePathByHash(domainHash: string): string {
    mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
    return path.join(
        CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR,
        `domain-${domainHash}.lock`
    );
}

function getBrowserDomainLockFilePath(domainKey: string): string {
    return getBrowserDomainLockFilePathByHash(getBrowserDomainHash(domainKey));
}

function getLocalBrowserSessionModeFromDomainKey(domainKey: string): LocalBrowserSessionMode {
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

function getBrowserDomainMetadataPath(domainKey: string): string {
    mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
    const sessionMode = getLocalBrowserSessionModeFromDomainKey(domainKey);
    return path.join(
        CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR,
        `${LOCAL_BROWSER_DOMAIN_METADATA_PREFIX}${sessionMode}-${getBrowserDomainHash(domainKey)}.json`
    );
}

function listBrowserDomainMetadataEntries(): BrowserDomainMetadataEntry[] {
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

export function buildLocalBrowserProcessArgs(
    port: number,
    tempDir: string,
    launchArgs: string[],
    headless = false,
    cfg: AppConfig = config
): string[] {
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${tempDir}`,
        ...launchArgs
    ];

    if (headless) {
        args.push('--headless=new');
    }

    args.push('--edge-skip-compat-layer-relaunch');

    const proxy = buildPlaywrightProxy(cfg);

    if (proxy?.server) {
        args.push(`--proxy-server=${proxy.server}`);
        if (proxy.bypass) {
            args.push(`--proxy-bypass-list=${formatChromiumProxyBypassList(proxy.bypass)}`);
        }
        if (proxy.username || proxy.password) {
            console.warn('Playwright local browser process proxy authentication is not applied via command-line flags. Use WS/CDP mode if authenticated proxy support is required.');
        }
    }

    return args;
}

export const BROWSER_METADATA_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

function normalizeBrowserDomainMetadata(
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
            // 超龄 metadata（>12h）：必须先检查浏览器与客户端 PID 是否仍存活，区分三类情形：
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

function readBrowserDomainMetadata(domainKey: string): LocalBrowserSessionMetadata | null {
    return readBrowserDomainMetadataFromPath(
        getBrowserDomainMetadataPath(domainKey),
        getLocalBrowserSessionModeFromDomainKey(domainKey),
        domainKey
    );
}

function serializeBrowserDomainMetadata(metadata: LocalBrowserSessionMetadata): LocalBrowserSessionMetadataFile {
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

function writeBrowserDomainMetadata(metadata: LocalBrowserSessionMetadata): void {
    const metadataPath = metadata.domainKey
        ? getBrowserDomainMetadataPath(metadata.domainKey)
        : metadata.metadataPath;
    if (!metadataPath) return;

    try {
        writeFileSync(
            metadataPath,
            JSON.stringify(serializeBrowserDomainMetadata(metadata), null, 2),
            'utf8'
        );
    } catch {
        // metadata 写入失败只影响跨进程复用，当前进程仍然可以继续使用已连接的浏览器。
    }
}

function readBrowserDomainMetadataTempDirFromPath(metadataPath: string): string | undefined {
    try {
        const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as Partial<LocalBrowserSessionMetadataFile>;
        return typeof parsed.tempDir === 'string' ? parsed.tempDir : undefined;
    } catch {
        return undefined;
    }
}

function clearBrowserDomainMetadataFromPath(metadataPath: string, tempDir?: string): void {
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

function clearBrowserDomainMetadata(domainKey: string, tempDir?: string): void {
    clearBrowserDomainMetadataFromPath(getBrowserDomainMetadataPath(domainKey), tempDir);
}

function processExists(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function normalizeActiveClientPids(clientPids: number[]): number[] {
    return [...new Set(clientPids.filter((pid) => processExists(pid)))];
}

function shouldTrackLocalBrowserSessionClients(sessionMode: LocalBrowserSessionMode): boolean {
    return sessionMode !== 'headed';
}

function registerLocalBrowserSessionClient(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
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

function unregisterLocalBrowserSessionClient(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
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

function isExecTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const candidate = error as {
        code?: unknown;
        message?: unknown;
    };

    return candidate.code === 'ETIMEDOUT'
        || (typeof candidate.message === 'string' && candidate.message.includes('ETIMEDOUT'));
}

function createProcessInspectionTimeoutError(message: string, cause: unknown): Error {
    const error = new Error(message);
    error.name = 'LocalBrowserProcessInspectionTimeoutError';
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
}

function isProcessInspectionTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.name === 'LocalBrowserProcessInspectionTimeoutError';
}

function invalidateLocalBrowserCandidatesCache(tempDir?: string): void {
    if (tempDir) {
        for (const key of localBrowserCandidatesCache.keys()) {
            if (key.startsWith(tempDir)) {
                localBrowserCandidatesCache.delete(key);
            }
        }
    } else {
        localBrowserCandidatesCache.clear();
    }
}

async function getProcessCommandLine(pid: number): Promise<string | null> {
    if (!processExists(pid)) {
        processCommandLineCache.delete(pid);
        return null;
    }

    const cached = processCommandLineCache.get(pid);
    if (cached !== undefined) {
        return cached;
    }

    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
                ],
                { encoding: 'utf8', windowsHide: true, timeout: 5000 }
            );
            const trimmed = stdout.trim() || null;
            if (trimmed) {
                processCommandLineCache.set(pid, trimmed);
            }
            return trimmed;
        }

        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8',
            timeout: 5000
        });
        const trimmed = stdout.trim() || null;
        if (trimmed) {
            processCommandLineCache.set(pid, trimmed);
        }
        return trimmed;
    } catch (error) {
        if (process.platform === 'win32' && isExecTimeoutError(error)) {
            throw createProcessInspectionTimeoutError(
                `PowerShell timed out while querying command line for PID ${pid}`,
                error
            );
        }

        return null;
    }
}

function getLocalBrowserDebugPortCommandLineFragment(debugPort?: number): string {
    return isValidLocalBrowserDebugPort(debugPort)
        ? `--remote-debugging-port=${debugPort}`
        : '--remote-debugging-port=';
}

function isValidLocalBrowserDebugPort(debugPort: number | undefined): debugPort is number {
    return typeof debugPort === 'number' && Number.isInteger(debugPort) && debugPort > 0;
}

function extractLocalBrowserDebugPortFromCommandLine(commandLine: string): number | undefined {
    const match = commandLine.match(/--remote-debugging-port=(\d+)/u);
    if (!match) {
        return undefined;
    }

    const debugPort = Number(match[1]);
    return Number.isInteger(debugPort) && debugPort > 0 ? debugPort : undefined;
}

function commandLineMatchesLocalBrowserCandidate(commandLine: string, tempDir: string, debugPort?: number): boolean {
    return commandLine.includes(tempDir)
        && commandLine.includes(getLocalBrowserDebugPortCommandLineFragment(debugPort))
        && !commandLine.includes('--type=');
}

function createLocalBrowserCandidateFromCommandLine(
    pid: number,
    commandLine: string,
    tempDir: string,
    debugPort?: number
): LocalBrowserProcessCandidate | null {
    if (!Number.isInteger(pid) || pid <= 0 || !commandLineMatchesLocalBrowserCandidate(commandLine, tempDir, debugPort)) {
        return null;
    }

    const candidateDebugPort = extractLocalBrowserDebugPortFromCommandLine(commandLine);
    if (!candidateDebugPort) {
        return null;
    }

    if (isValidLocalBrowserDebugPort(debugPort) && candidateDebugPort !== debugPort) {
        return null;
    }

    return { pid, debugPort: candidateDebugPort };
}

async function getLocalBrowserCandidateFromPid(pid: number, tempDir: string, debugPort?: number): Promise<LocalBrowserProcessCandidate | null> {
    const commandLine = await getProcessCommandLine(pid);
    return commandLine
        ? createLocalBrowserCandidateFromCommandLine(pid, commandLine, tempDir, debugPort)
        : null;
}

function quotePowerShellSingleQuotedString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

async function listLocalBrowserCandidatesByTempDir(tempDir: string, debugPort?: number): Promise<LocalBrowserProcessCandidate[]> {
    const debugPortFragment = getLocalBrowserDebugPortCommandLineFragment(debugPort);
    const cacheKey = `${tempDir}::${debugPort ?? ''}`;
    const cached = localBrowserCandidatesCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CANDIDATES_CACHE_TTL_MS) {
        return cached.candidates.filter((candidate) => processExists(candidate.pid));
    }

    if (process.platform !== 'win32') {
        try {
            const { stdout: raw } = await execFileAsync('ps', ['-eo', 'pid=,command='], {
                encoding: 'utf8',
                timeout: 5000
            });
            const candidates = raw.split(/\r?\n/u)
                .map((line) => {
                    const match = line.match(/^\s*(\d+)\s+(.*)$/u);
                    if (!match) return null;
                    const pid = Number(match[1]);
                    const commandLine = match[2];
                    if (!commandLine) return null;
                    if (Number.isInteger(pid)) {
                        processCommandLineCache.set(pid, commandLine);
                    }
                    return createLocalBrowserCandidateFromCommandLine(pid, commandLine, tempDir, debugPort);
                })
                .filter((candidate): candidate is LocalBrowserProcessCandidate => candidate !== null && processExists(candidate.pid));

            localBrowserCandidatesCache.set(cacheKey, { timestamp: Date.now(), candidates });
            return candidates;
        } catch {
            return [];
        }
    }

    try {
        const script = [
            `$targetTempDir = ${quotePowerShellSingleQuotedString(tempDir)}`,
            `$debugPortFragment = ${quotePowerShellSingleQuotedString(debugPortFragment)}`,
            "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($targetTempDir) -and $_.CommandLine.Contains($debugPortFragment) -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,CommandLine | Sort-Object ProcessId | ConvertTo-Json -Compress"
        ].join('; ');
        const { stdout: rawOutput } = await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 }
        );
        const raw = rawOutput.trim();

        if (!raw) {
            localBrowserCandidatesCache.set(cacheKey, { timestamp: Date.now(), candidates: [] });
            return [];
        }

        const parsed = JSON.parse(raw) as Array<{ ProcessId?: number; CommandLine?: string }> | { ProcessId?: number; CommandLine?: string };
        const processes = Array.isArray(parsed) ? parsed : [parsed];
        const candidates = processes
            .map((processInfo) => {
                const pid = processInfo.ProcessId;
                const commandLine = processInfo.CommandLine;
                if (!Number.isInteger(pid) || typeof commandLine !== 'string') {
                    return null;
                }
                processCommandLineCache.set(pid as number, commandLine);
                return createLocalBrowserCandidateFromCommandLine(pid as number, commandLine, tempDir, debugPort);
            })
            .filter((candidate): candidate is LocalBrowserProcessCandidate => candidate !== null && processExists(candidate.pid));

        localBrowserCandidatesCache.set(cacheKey, { timestamp: Date.now(), candidates });
        return candidates;
    } catch (error) {
        if (isExecTimeoutError(error)) {
            throw createProcessInspectionTimeoutError(
                `PowerShell timed out while enumerating local browser candidate processes for ${tempDir}`,
                error
            );
        }

        return [];
    }
}

async function resolveLocalBrowserCandidate(preferredPid: number | undefined, tempDir: string, debugPort?: number): Promise<LocalBrowserProcessCandidate | null> {
    if (preferredPid) {
        const preferredCandidate = await getLocalBrowserCandidateFromPid(preferredPid, tempDir, debugPort);
        if (preferredCandidate) {
            return preferredCandidate;
        }
    }

    const exactCandidates = await listLocalBrowserCandidatesByTempDir(tempDir, debugPort);
    if (exactCandidates.length > 0) {
        return exactCandidates[0] ?? null;
    }

    if (isValidLocalBrowserDebugPort(debugPort)) {
        return null;
    }

    const tempDirCandidates = await listLocalBrowserCandidatesByTempDir(tempDir);
    return tempDirCandidates[0] ?? null;
}

async function resolveLocalBrowserCandidatePid(preferredPid: number | undefined, tempDir: string, debugPort?: number): Promise<number | undefined> {
    const candidate = await resolveLocalBrowserCandidate(preferredPid, tempDir, debugPort);
    return candidate?.pid;
}

async function requireLocalBrowserCandidatePid(preferredPid: number | undefined, tempDir: string, debugPort: number, context: string): Promise<number> {
    const candidatePid = await resolveLocalBrowserCandidatePid(preferredPid, tempDir, debugPort);
    if (!candidatePid) {
        throw new Error(`${context}: local browser process could not be verified by tempDir/debugPort`);
    }
    return candidatePid;
}

function quoteWindowsCommandLineArg(arg: string): string {
    if (arg.length === 0) {
        return '""';
    }

    if (!/[\s"]/u.test(arg)) {
        return arg;
    }

    let escaped = '"';
    let backslashCount = 0;

    for (const char of arg) {
        if (char === '\\') {
            backslashCount += 1;
            continue;
        }

        if (char === '"') {
            escaped += '\\'.repeat(backslashCount * 2 + 1);
            escaped += '"';
            backslashCount = 0;
            continue;
        }

        if (backslashCount > 0) {
            escaped += '\\'.repeat(backslashCount);
            backslashCount = 0;
        }

        escaped += char;
    }

    if (backslashCount > 0) {
        escaped += '\\'.repeat(backslashCount * 2);
    }

    escaped += '"';
    return escaped;
}

function trackLocalBrowserSessionClientForReuse(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    if (!shouldTrackLocalBrowserSessionClients(metadata.sessionMode)) {
        return { ...metadata, clientPids: [] };
    }

    return registerLocalBrowserSessionClient(metadata, pid);
}

async function doCleanupStaleLocalBrowserSessions(): Promise<void> {
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

            // P0-3 快速路径：若客户端 PID 全部已死亡，无需慢速枚举，直接强杀与清理
            if (shouldTrackLocalBrowserSessionClients(metadata.sessionMode) && activeClients.length === 0 && metadata.clientPids.length > 0) {
                createForceKill(metadata.browserPid, metadata.tempDir)();
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

const STALE_BROWSER_CLEANUP_BUDGET_MS = 8000;

/**
 * 后台扫描并清理因历史进程崩溃、断电或异常终止遗留的孤儿浏览器临时目录（mcp-search-*）。
 * 异步执行，不占用主事件循环，不计入启动/清理预算。
 */
export async function cleanOrphanTempProfilesInBackground(maxAgeMs = 60 * 60 * 1000): Promise<void> {
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
        if (cachedLocalBrowserSession?.tempDir) {
            activeTempDirs.add(cachedLocalBrowserSession.tempDir);
        }

        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('mcp-search-')) {
                const fullPath = path.join(tempRoot, entry.name);
                if (activeTempDirs.has(fullPath)) {
                    continue;
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
            }
        }
    } catch {
        // 忽略后台扫描异常
    }
}

async function cleanupStaleLocalBrowserSessions(): Promise<void> {
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
        void cleanOrphanTempProfilesInBackground().catch(() => undefined);
    } catch (error) {
        console.warn('[browserSession] cleanupStaleLocalBrowserSessions exceeded budget or failed, proceeding with fresh launch:', error instanceof Error ? error.message : String(error));
        // 不阻断冷启动：允许下次有机会再重试清理
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function waitForBrowserReadyViaStdout(
    source: { type: 'pipe'; readHandle: unknown } | { type: 'child'; child: ChildProcess },
    timeoutMs = 30000
): Promise<string> {
    let accumulated = '';

    if (source.type === 'pipe') {
        const readLoop = (async () => {
            while (true) {
                const chunk = await readNamedPipeAsync(source.readHandle, 4096);
                if (!chunk || chunk.length === 0) break;
                accumulated += chunk.toString('utf-8');
                const match = accumulated.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match?.[1]) return match[1];
            }
            throw new Error('Pipe closed before browser emitted DevTools ready signal');
        })();

        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Browser did not emit DevTools ready signal within ${timeoutMs}ms`)), timeoutMs);
            if (typeof timer === 'object' && 'unref' in timer) (timer as NodeJS.Timeout).unref();
        });

        try {
            return await Promise.race([readLoop, timeout]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    } else {
        const child = source.child;
        return new Promise<string>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                finish(new Error(`Browser did not emit DevTools ready signal within ${timeoutMs}ms`));
            }, timeoutMs);
            if (typeof timer === 'object' && 'unref' in timer) (timer as NodeJS.Timeout).unref();

            const cleanup = () => {
                clearTimeout(timer);
                child.stdout?.removeListener('data', onData);
                child.stderr?.removeListener('data', onData);
                child.removeListener('error', onError);
                child.removeListener('exit', onExit);
                child.removeListener('close', onClose);
            };

            const finish = (error: Error | null, value?: string) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (error) {
                    reject(error);
                } else {
                    resolve(value ?? '');
                }
            };

            const onData = (data: Buffer) => {
                accumulated += data.toString('utf-8');
                const match = accumulated.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) {
                    finish(null, match[1]);
                }
            };

            const onError = (error: Error) => {
                finish(error);
            };

            const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
                const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
                finish(new Error(`Browser process exited before emitting DevTools ready signal (${detail})`));
            };

            const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
                const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
                finish(new Error(`Browser process closed before emitting DevTools ready signal (${detail})`));
            };

            child.stdout?.on('data', onData);
            child.stderr?.on('data', onData);
            child.on('error', onError);
            child.on('exit', onExit);
            child.on('close', onClose);
        });
    }
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
        browser = await connectOverCdpWhenReady(playwright, endpoint);
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

        const domainLockPath = getBrowserDomainLockFilePath(session.domainKey);
        const domainLock = acquireNativeFileLock(domainLockPath);

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
        // [P0 修复] 异步删除，避免 rmSync 递归删除 profile 冻结事件循环（实测最长 52.9s）
        removeTempDirInBackground(session.tempDir);
    }
}

export function createForceKill(browserPid?: number, tempDir?: string, browser?: PlaywrightBrowserLike, domainKey?: string): () => void {
    return () => {
        try {
            browser?.disconnect?.();
        } catch {
            // Ignore disconnect errors.
        }

        if (browserPid) {
            processCommandLineCache.delete(browserPid);
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
                    process.kill(-browserPid);
                } catch {
                    // Ignore group kill errors.
                }
                try {
                    process.kill(browserPid);
                } catch {
                    // Ignore direct kill errors.
                }
            }
        }

        if (tempDir) {
            invalidateLocalBrowserCandidatesCache(tempDir);
            try {
                if (domainKey) {
                    clearBrowserDomainMetadata(domainKey, tempDir);
                }
                // [P0 修复] 异步删除，避免 rmSync 递归删除 Chrome profile 冻结主事件循环
                // （实测僵尸 profile 目录同步删除阻塞 52.9s，连带冻结所有并发请求与预算定时器）
                removeTempDirInBackground(tempDir);
            } catch {
                // Ignore cleanup errors.
            }
        }
    };
}

function createLocalBrowserLaunchError(message: string, browserPid?: number, cause?: unknown): Error {
    const error = new Error(message);
    error.name = 'LocalBrowserLaunchError';
    if (Number.isInteger(browserPid) && browserPid! > 0) {
        (error as Error & { browserPid?: number }).browserPid = browserPid;
    }
    if (cause !== undefined) {
        (error as Error & { cause?: unknown }).cause = cause;
    }
    return error;
}

function getLocalBrowserLaunchErrorPid(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') {
        return undefined;
    }

    const browserPid = (error as { browserPid?: unknown }).browserPid;
    return Number.isInteger(browserPid) && (browserPid as number) > 0
        ? browserPid as number
        : undefined;
}

async function resolveLaunchFailureBrowserPid(preferredPid: number | undefined, tempDir: string, debugPort: number, error?: unknown): Promise<number | undefined> {
    return getLocalBrowserLaunchErrorPid(error)
        ?? await resolveLocalBrowserCandidatePid(preferredPid, tempDir, debugPort);
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

async function connectLaunchedLocalBrowserSession(
    playwright: PlaywrightModule,
    endpoint: string,
    preferredPid: number | undefined,
    tempDir: string,
    debugPort: number,
    context: string
): Promise<{ browser: PlaywrightBrowserLike; browserPid: number }> {
    let browser: PlaywrightBrowserLike;
    let verifiedBrowserPid: number | undefined;
    try {
        browser = await connectOverCdpWhenReady(playwright, endpoint);
    } catch (error) {
        const candidatePid = await resolveLocalBrowserCandidatePid(preferredPid, tempDir, debugPort);
        if (!candidatePid) {
            throw createLocalBrowserLaunchError(
                `${context}: CDP connection failed and no local browser process matched tempDir/debugPort: ${getErrorMessage(error)}`,
                undefined,
                error
            );
        }

        verifiedBrowserPid = candidatePid;
        try {
            browser = await connectOverCdpWhenReady(playwright, endpoint);
        } catch (retryError) {
            throw createLocalBrowserLaunchError(
                `${context}: CDP connection failed for verified local browser process PID ${candidatePid}: ${getErrorMessage(retryError)}`,
                candidatePid,
                retryError
            );
        }
    }

    try {
        const browserPid = await requireLocalBrowserCandidatePid(preferredPid, tempDir, debugPort, context);
        return { browser, browserPid };
    } catch (error) {
        await closeConnectedCdpBrowser(browser);
        throw createLocalBrowserLaunchError(
            error instanceof Error ? error.message : `${context}: local browser process verification failed`,
            verifiedBrowserPid,
            error
        );
    }
}

async function launchHiddenDesktopBrowser(playwright: PlaywrightModule, sessionKey: string, domainKey: string, launchArgs: string[]): Promise<LocalBrowserSession> {
    const browserPath = getLocalBrowserExecutablePath();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-search-'));
    const port = await findFreePort();
    const args = buildLocalBrowserProcessArgs(port, tempDir, launchArgs);
    const cmdLine = [quoteWindowsCommandLineArg(browserPath), ...args.map((arg) => quoteWindowsCommandLineArg(arg))].join(' ');

    let browserPid: number | undefined;
    let pipeHandle: unknown = null;

    if (process.platform === 'win32') {
        const desktopName = `mcp-search-${Date.now()}`;
        const result = launchProcessOnHiddenDesktopWithPipes(cmdLine, desktopName);
        browserPid = result.pid;
        pipeHandle = result.readStdoutHandle;
        console.error(`🧭 Playwright browser started on hidden desktop "${desktopName}" (PID: ${browserPid})`);
    } else {
        const child = spawn(browserPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        });
        browserPid = child.pid;

        try {
            await waitForBrowserReadyViaStdout({ type: 'child', child });
        } catch (error) {
            detachLaunchedChildProcess(child);
            createForceKill(await resolveLaunchFailureBrowserPid(browserPid, tempDir, port, error), tempDir, undefined, domainKey)();
            throw error;
        }

        detachLaunchedChildProcess(child);

        const endpoint = `http://127.0.0.1:${port}`;
        try {
            const connectedSession = await connectLaunchedLocalBrowserSession(
                playwright,
                endpoint,
                browserPid,
                tempDir,
                port,
                'Hidden local browser launch'
            );
            const browser = connectedSession.browser;
            browserPid = connectedSession.browserPid;
            writeBrowserDomainMetadata({
                domainKey,
                sessionMode: 'hidden-headed',
                browserPid,
                debugPort: port,
                tempDir,
                clientPids: [process.pid]
            });
            const forceKill = createForceKill(browserPid, tempDir, browser, domainKey);
            const session: LocalBrowserSession = {
                browser, sessionKey, domainKey, sessionMode: 'hidden-headed',
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

    try {
        await waitForBrowserReadyViaStdout({ type: 'pipe', readHandle: pipeHandle });
    } catch (error) {
        closeHandle(pipeHandle);
        createForceKill(await resolveLaunchFailureBrowserPid(browserPid, tempDir, port, error), tempDir, undefined, domainKey)();
        throw error;
    }
    closeHandle(pipeHandle);

    const endpoint = `http://127.0.0.1:${port}`;
    try {
        const connectedSession = await connectLaunchedLocalBrowserSession(
            playwright,
            endpoint,
            browserPid,
            tempDir,
            port,
            'Hidden desktop local browser launch'
        );
        browserPid = connectedSession.browserPid;
        const browser = connectedSession.browser;
        writeBrowserDomainMetadata({
            domainKey,
            sessionMode: 'hidden-headed',
            browserPid,
            debugPort: port,
            tempDir,
            clientPids: [process.pid]
        });
        const forceKill = createForceKill(browserPid, tempDir, browser, domainKey);
        const session: LocalBrowserSession = {
            browser, sessionKey, domainKey, sessionMode: 'hidden-headed',
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

async function launchStandardLocalBrowser(playwright: PlaywrightModule, sessionKey: string, domainKey: string, headless: boolean, launchArgs: string[]): Promise<LocalBrowserSession> {
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
}

export async function getOrCreateLocalBrowserSession(
    playwright: PlaywrightModule,
    headless: boolean,
    launchArgs: string[],
    options?: OpenPlaywrightBrowserOptions
): Promise<LocalBrowserSession> {
    const sessionKey = buildLocalSessionKey(headless, launchArgs, options);
    const sessionMode = getLocalBrowserSessionMode(headless, options);
    cachedLocalBrowserSessionOptions = {
        headless,
        launchArgs: [...launchArgs],
        options: options ? { ...options } : undefined
    };

    await cleanupStaleLocalBrowserSessions();

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
        throw new Error('Playwright client is not available. Install `playwright` or `playwright-core`, or configure PLAYWRIGHT_EXECUTABLE_PATH / PLAYWRIGHT_CDP_ENDPOINT.');
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
