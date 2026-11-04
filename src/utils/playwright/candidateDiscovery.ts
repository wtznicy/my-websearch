import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalBrowserProcessCandidate } from './types.js';

const execFileAsync = promisify(execFile);

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
    return commandLine
        ? createLocalBrowserCandidateFromCommandLine(pid, commandLine, tempDir, debugPort)
        : null;
}

export function quotePowerShellSingleQuotedString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export async function listLocalBrowserCandidatesByTempDir(tempDir: string, debugPort?: number): Promise<LocalBrowserProcessCandidate[]> {
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
