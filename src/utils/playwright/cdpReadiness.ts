import { ChildProcess } from 'node:child_process';
import { config } from '../../config.js';
import {
    readNamedPipeAsync
} from '../nativeInterop.js';
import {
    PlaywrightBrowserLike,
    PlaywrightModule
} from './types.js';
import {
    requireLocalBrowserCandidatePid,
    resolveLocalBrowserCandidatePid
} from './candidateDiscovery.js';

export const PLAYWRIGHT_CONNECT_TIMEOUT_MS = Math.max(config.playwrightNavigationTimeoutMs, 30000);
export const PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS = Math.max(config.playwrightNavigationTimeoutMs * 2, 60000);
export const PLAYWRIGHT_LOCAL_CDP_READINESS_INITIAL_PROBE_TIMEOUT_MS = 1000;
export const PLAYWRIGHT_LOCAL_CDP_READINESS_POLL_INTERVAL_MS = 1000;

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

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function waitForTimeout(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

export async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

export async function connectOverCdpOnly(
    playwright: PlaywrightModule,
    endpoint: string,
    timeout: number
): Promise<PlaywrightBrowserLike> {
    return playwright.chromium.connectOverCDP(endpoint, { timeout });
}

export async function closeConnectedCdpBrowser(browser: PlaywrightBrowserLike | unknown, timeoutMs = 3000): Promise<void> {
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

export async function probeLocalCdpReadiness(
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

export async function connectOverCdpWhenReady(
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

export function createLocalBrowserLaunchError(message: string, browserPid?: number, cause?: unknown): Error {
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

export async function waitForBrowserReadyViaStdout(
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

export async function connectLaunchedLocalBrowserSession(
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
