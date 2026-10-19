import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';
import { CliEnvelope } from './protocol.js';
import { ErrorCode } from '../core/errors.js';

export type CliIo = {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
};

export type ParsedServeArgs = {
    host: string;
    port: number;
    json: boolean;
};

export type RunCliOptions = {
    spawnDaemon?: (args: ParsedServeArgs) => Promise<void> | void;
    signalSource?: Pick<EventEmitter, 'once' | 'removeListener'>;
};

export type CommandContext = {
    argv: string[];
    io: CliIo;
    runtime: MyWebSearchRuntime;
    options: RunCliOptions;
};

// 从 package.json 读取真实版本号（编译后位于 build/cli/runCli.js，需上溯两级）
export function readServerVersion(): string {
    try {
        const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
        return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;
    } catch {
        return 'unknown';
    }
}

export function isFlag(value: string): boolean {
    return value.startsWith('--');
}

export function requireFlagValue(argv: string[], index: number, flagName: string): string {
    const next = argv[index + 1];
    if (!next || isFlag(next)) {
        throw new Error(`Missing value for ${flagName}`);
    }
    return next;
}

export type DaemonTransportArgs = {
    argv: string[];
    daemonUrl: string;
    daemonUrlExplicit: boolean;
    spawn: boolean;
};

export class DaemonUnavailableError extends Error {}
export class DaemonRequestTimeoutError extends Error {}
export class DaemonRequestFailedError extends Error {}

export function getDefaultDaemonBaseUrl(): string {
    return process.env.OPEN_WEBSEARCH_DAEMON_URL || `http://127.0.0.1:${process.env.OPEN_WEBSEARCH_DAEMON_PORT || '3210'}`;
}

export function parsePositiveTimeout(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getDaemonActionTimeoutMs(transport: DaemonTransportArgs): number {
    if (transport.daemonUrlExplicit) {
        return parsePositiveTimeout(process.env.OPEN_WEBSEARCH_DAEMON_ACTION_TIMEOUT_MS, 15000);
    }

    return parsePositiveTimeout(process.env.OPEN_WEBSEARCH_DAEMON_DISCOVERY_TIMEOUT_MS, 300);
}

export function extractDaemonTransportArgs(argv: string[]): DaemonTransportArgs {
    const passthrough: string[] = [];
    let daemonUrl = getDefaultDaemonBaseUrl();
    let daemonUrlExplicit = Boolean(process.env.OPEN_WEBSEARCH_DAEMON_URL);
    let shouldSpawn = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg) {
            continue;
        }

        if (arg === '--spawn') {
            shouldSpawn = true;
            continue;
        }

        if (arg === '--base-url') {
            throw new Error('--base-url is only valid with `my-websearch status`. Use --daemon-url for search and fetch commands.');
        }

        if (arg === '--daemon-url') {
            daemonUrl = requireFlagValue(argv, index, '--daemon-url');
            daemonUrlExplicit = true;
            index += 1;
            continue;
        }

        passthrough.push(arg);
    }

    return {
        argv: passthrough,
        daemonUrl,
        daemonUrlExplicit,
        spawn: shouldSpawn
    };
}

export async function requestJsonWithTimeout<T>(
    url: string,
    options: {
        method?: 'GET' | 'POST';
        body?: Record<string, unknown>;
        timeoutMs: number;
    }
): Promise<T> {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = options.body ? JSON.stringify(options.body) : null;
    const method = options.method ?? 'GET';

    return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            req.destroy(new Error(`Timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);

        const req = transport.request(target, {
            method,
            timeout: options.timeoutMs,
            headers: payload ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            } : undefined
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                clearTimeout(timer);
                try {
                    resolve(JSON.parse(data) as T);
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`Timed out after ${options.timeoutMs}ms`));
        });
        req.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

export async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
    return requestJsonWithTimeout<T>(url, {
        method: 'GET',
        timeoutMs
    });
}

export async function requestDaemonEnvelope<T>(
    transport: DaemonTransportArgs,
    path: string,
    body: Record<string, unknown>
): Promise<CliEnvelope<T>> {
    const timeoutMs = getDaemonActionTimeoutMs(transport);

    try {
        return await requestJsonWithTimeout<CliEnvelope<T>>(new URL(path, transport.daemonUrl).toString(), {
            method: 'POST',
            body,
            timeoutMs
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Timed out after')) {
            throw new DaemonRequestTimeoutError(`Local daemon at ${transport.daemonUrl} timed out after ${timeoutMs}ms while processing ${path}`);
        }

        if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('EHOSTUNREACH')) {
            throw new DaemonUnavailableError(`Local daemon at ${transport.daemonUrl} is not reachable: ${message}`);
        }

        throw new DaemonRequestFailedError(`Local daemon at ${transport.daemonUrl} failed while processing ${path}: ${message}`);
    }
}

export async function tryDaemonRequest<T>(
    transport: DaemonTransportArgs,
    path: string,
    body: Record<string, unknown>,
    options: RunCliOptions = {}
): Promise<CliEnvelope<T> | null> {
    try {
        return await requestDaemonEnvelope<T>(transport, path, body);
    } catch (error) {
        if (error instanceof DaemonUnavailableError && transport.spawn) {
            const serveArgs = resolveServeArgsFromDaemonUrl(transport.daemonUrl);
            await (options.spawnDaemon ?? defaultSpawnDaemon)(serveArgs);
            await waitForDaemonReady(transport.daemonUrl, 4000);
            return await requestDaemonEnvelope<T>(transport, path, body);
        }

        if (
            !transport.daemonUrlExplicit &&
            (error instanceof DaemonUnavailableError || error instanceof DaemonRequestTimeoutError || error instanceof DaemonRequestFailedError)
        ) {
            return null;
        }
        throw error;
    }
}

export function isSuccessEnvelope<T>(envelope: CliEnvelope<T>): envelope is CliEnvelope<T> & { status: 'ok'; data: T } {
    return envelope.status === 'ok' && envelope.data !== null;
}

export function formatEnvelopeError(envelope: CliEnvelope<unknown>): string {
    return envelope.error?.message ?? 'Unknown daemon error';
}

export function getDaemonCliErrorCode(error: unknown): string {
    if (error instanceof DaemonUnavailableError) {
        return ErrorCode.DAEMON_UNAVAILABLE;
    }

    if (error instanceof DaemonRequestTimeoutError) {
        return ErrorCode.DAEMON_TIMEOUT;
    }

    if (error instanceof DaemonRequestFailedError) {
        return ErrorCode.DAEMON_REQUEST_FAILED;
    }

    return ErrorCode.ENGINE_ERROR;
}

export function getDaemonCliErrorHint(error: unknown): string {
    if (error instanceof DaemonUnavailableError) {
        return 'Start the local daemon with `my-websearch serve`, or remove --daemon-url to use direct execution.';
    }

    if (error instanceof DaemonRequestTimeoutError) {
        return 'The daemon is reachable but did not finish the request in time. Retry with a simpler request, raise OPEN_WEBSEARCH_DAEMON_ACTION_TIMEOUT_MS, or use direct execution without --daemon-url.';
    }

    if (error instanceof DaemonRequestFailedError) {
        return 'The daemon accepted the request but did not complete it cleanly. Inspect daemon logs or retry without --daemon-url to use direct execution.';
    }

    return 'Retry with a different engine, or inspect proxy and search mode settings.';
}

export function getDaemonCliErrorLabel(error: unknown, fallback: string): string {
    if (error instanceof DaemonUnavailableError) {
        return 'Local daemon unavailable';
    }

    if (error instanceof DaemonRequestTimeoutError) {
        return 'Daemon request timed out';
    }

    if (error instanceof DaemonRequestFailedError) {
        return 'Daemon request failed';
    }

    return fallback;
}

export function isDaemonRequestError(error: unknown): boolean {
    return error instanceof DaemonUnavailableError
        || error instanceof DaemonRequestTimeoutError
        || error instanceof DaemonRequestFailedError;
}

export function resolveServeArgsFromDaemonUrl(daemonUrl: string): ParsedServeArgs {
    const parsed = new URL(daemonUrl);
    if (parsed.protocol !== 'http:') {
        throw new Error('Only local HTTP daemon URLs can be auto-started');
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
        throw new Error('Daemon URL for --spawn must not include a path');
    }
    if (!parsed.port) {
        throw new Error('Daemon URL for --spawn must include an explicit port');
    }

    const hostname = parsed.hostname;
    const isLocalHost = hostname === '127.0.0.1' || hostname === 'localhost';
    if (!isLocalHost) {
        throw new Error('Only localhost daemon URLs can be auto-started');
    }

    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Daemon URL for --spawn must include a valid port');
    }

    return {
        host: hostname === 'localhost' ? '127.0.0.1' : hostname,
        port,
        json: false
    };
}

export async function waitForDaemonReady(baseUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const payload = await fetchJsonWithTimeout<CliEnvelope<{ daemon: string }>>(
                new URL('/health', baseUrl).toString(),
                300
            );
            if (payload.status === 'ok') {
                return;
            }
        } catch {
            // Retry until timeout expires.
        }

        await new Promise((resolve) => setTimeout(resolve, 150));
    }

    throw new Error(`Timed out waiting for local daemon at ${baseUrl}`);
}

export async function defaultSpawnDaemon(args: ParsedServeArgs): Promise<void> {
    const entrypoint = process.argv[1];
    if (!entrypoint) {
        throw new Error('Cannot determine CLI entrypoint for --spawn');
    }

    const child = spawn(process.execPath, [entrypoint, 'serve', '--host', args.host, '--port', String(args.port)], {
        detached: true,
        stdio: 'ignore'
    });

    child.unref();
}
