import { LocalBrowserProcessCandidate } from './types.js';

export const processCommandLineCache = new Map<number, string>();

export interface CandidatesCacheEntry {
    timestamp: number;
    candidates: LocalBrowserProcessCandidate[];
}

export const localBrowserCandidatesCache = new Map<string, CandidatesCacheEntry>();
export const CANDIDATES_CACHE_TTL_MS = 2000;

export function processExists(pid: number): boolean {
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

export function isExecTimeoutError(error: unknown): boolean {
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

export function createProcessInspectionTimeoutError(message: string, cause: unknown): Error {
    const error = new Error(message);
    error.name = 'LocalBrowserProcessInspectionTimeoutError';
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
}

export function isProcessInspectionTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.name === 'LocalBrowserProcessInspectionTimeoutError';
}

export function invalidateLocalBrowserCandidatesCache(tempDir?: string): void {
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

export async function getProcessCommandLine(pid: number): Promise<string | null> {
    if (!processExists(pid)) {
        processCommandLineCache.delete(pid);
        return null;
    }

    return processCommandLineCache.get(pid) ?? null;
}

export function getLocalBrowserDebugPortCommandLineFragment(debugPort?: number): string {
    return isValidLocalBrowserDebugPort(debugPort)
        ? `--remote-debugging-port=${debugPort}`
        : '--remote-debugging-port=';
}

export function isValidLocalBrowserDebugPort(debugPort: number | undefined): debugPort is number {
    return typeof debugPort === 'number' && Number.isInteger(debugPort) && debugPort > 0;
}

export function extractLocalBrowserDebugPortFromCommandLine(commandLine: string): number | undefined {
    const match = commandLine.match(/--remote-debugging-port=(\d+)/u);
    if (!match) {
        return undefined;
    }

    const debugPort = Number(match[1]);
    return Number.isInteger(debugPort) && debugPort > 0 ? debugPort : undefined;
}

export function commandLineMatchesLocalBrowserCandidate(commandLine: string, tempDir: string, debugPort?: number): boolean {
    return commandLine.includes(tempDir)
        && commandLine.includes(getLocalBrowserDebugPortCommandLineFragment(debugPort))
        && !commandLine.includes('--type=');
}

export function createLocalBrowserCandidateFromCommandLine(
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

export async function getLocalBrowserCandidateFromPid(pid: number, tempDir: string, debugPort?: number): Promise<LocalBrowserProcessCandidate | null> {
    const commandLine = await getProcessCommandLine(pid);
    if (commandLine) {
        return createLocalBrowserCandidateFromCommandLine(pid, commandLine, tempDir, debugPort);
    }
    return processExists(pid)
        ? { pid, debugPort: isValidLocalBrowserDebugPort(debugPort) ? debugPort : 0 }
        : null;
}

export function quotePowerShellSingleQuotedString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export async function listLocalBrowserCandidatesByTempDir(tempDir: string, debugPort?: number): Promise<LocalBrowserProcessCandidate[]> {
    const cacheKey = `${tempDir}::${debugPort ?? ''}`;
    const cached = localBrowserCandidatesCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CANDIDATES_CACHE_TTL_MS) {
        return cached.candidates.filter((candidate) => processExists(candidate.pid));
    }
    return [];
}

export async function resolveLocalBrowserCandidate(preferredPid: number | undefined, tempDir: string, debugPort?: number): Promise<LocalBrowserProcessCandidate | null> {
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

export async function resolveLocalBrowserCandidatePid(preferredPid: number | undefined, tempDir: string, debugPort?: number): Promise<number | undefined> {
    const candidate = await resolveLocalBrowserCandidate(preferredPid, tempDir, debugPort);
    return candidate?.pid;
}

export async function requireLocalBrowserCandidatePid(preferredPid: number | undefined, tempDir: string, debugPort: number, context: string): Promise<number> {
    if (preferredPid && processExists(preferredPid)) {
        return preferredPid;
    }

    const candidatePid = await resolveLocalBrowserCandidatePid(preferredPid, tempDir, debugPort);
    if (!candidatePid) {
        throw new Error(`${context}: local browser process could not be verified by tempDir/debugPort`);
    }
    return candidatePid;
}

export function getLocalBrowserLaunchErrorPid(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') {
        return undefined;
    }

    const browserPid = (error as { browserPid?: unknown }).browserPid;
    return Number.isInteger(browserPid) && (browserPid as number) > 0
        ? browserPid as number
        : undefined;
}

export async function resolveLaunchFailureBrowserPid(preferredPid: number | undefined, tempDir: string, debugPort: number, error?: unknown): Promise<number | undefined> {
    return getLocalBrowserLaunchErrorPid(error)
        ?? await resolveLocalBrowserCandidatePid(preferredPid, tempDir, debugPort);
}
