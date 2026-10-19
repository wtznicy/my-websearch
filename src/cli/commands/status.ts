import { createErrorEnvelope, CliEnvelope } from '../protocol.js';
import { ErrorCode } from '../../core/errors.js';
import {
    CommandContext,
    fetchJsonWithTimeout,
    formatEnvelopeError,
    isFlag,
    isSuccessEnvelope,
    requireFlagValue
} from '../shared.js';

export type ParsedStatusArgs = {
    baseUrl: string;
    json: boolean;
};

export function parseStatusArgs(argv: string[]): ParsedStatusArgs {
    let baseUrl = process.env.OPEN_WEBSEARCH_DAEMON_URL || `http://127.0.0.1:${process.env.OPEN_WEBSEARCH_DAEMON_PORT || '3210'}`;
    let json = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg) {
            continue;
        }

        if (arg === '--json') {
            json = true;
            continue;
        }

        if (arg === '--daemon-url') {
            throw new Error('--daemon-url is only valid for search and fetch commands. Use --base-url with `my-websearch status`.');
        }

        if (arg === '--base-url') {
            baseUrl = requireFlagValue(argv, index, '--base-url');
            index += 1;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        throw new Error(`Unexpected positional argument: ${arg}`);
    }

    return {
        // 去掉尾斜杠，避免与后续 /status 拼成 //status
        baseUrl: baseUrl.replace(/\/+$/, ''),
        json
    };
}

export function formatStatusHumanReadable(status: {
    daemon: string;
    runtime: string;
    activation: string;
    version: string;
    capabilities: string[];
    baseUrl: string;
    configSummary: {
        defaultSearchEngine: string;
        allowedSearchEngines: string[];
        searchMode: string;
        useProxy: boolean;
        fetchWebAllowInsecureTls: boolean;
    };
}): string {
    return [
        `Daemon: ${status.daemon}`,
        `Runtime: ${status.runtime}`,
        `Activation: ${status.activation}`,
        `Version: ${status.version}`,
        `Base URL: ${status.baseUrl}`,
        `Capabilities: ${status.capabilities.join(', ')}`,
        `Default engine: ${status.configSummary.defaultSearchEngine}`,
        `Allowed engines: ${status.configSummary.allowedSearchEngines.length > 0 ? status.configSummary.allowedSearchEngines.join(', ') : '(all)'}`,
        `Search mode: ${status.configSummary.searchMode}`,
        `Proxy enabled: ${status.configSummary.useProxy ? 'yes' : 'no'}`,
        `Fetch web insecure TLS: ${status.configSummary.fetchWebAllowInsecureTls ? 'yes' : 'no'}`
    ].join('\n');
}

type StatusPayload = CliEnvelope<{
    daemon: string;
    runtime: string;
    activation: string;
    version: string;
    capabilities: string[];
    baseUrl: string;
    configSummary: {
        defaultSearchEngine: string;
        allowedSearchEngines: string[];
        searchMode: string;
        useProxy: boolean;
        fetchWebAllowInsecureTls: boolean;
    };
}>;

export async function handleStatusCommand(ctx: CommandContext): Promise<number> {
    const { argv: rest, io } = ctx;
    let parsed: ParsedStatusArgs;
    try {
        parsed = parseStatusArgs(rest);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rest.includes('--json')) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: 'Use `my-websearch status [--base-url URL] [--json]`.' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch status [--base-url URL] [--json]');
        }
        return 1;
    }

    try {
        const payload = await fetchJsonWithTimeout<StatusPayload>(
            `${parsed.baseUrl}/status`,
            Number(process.env.OPEN_WEBSEARCH_DAEMON_TIMEOUT_MS || '2000')
        );
        if (parsed.json) {
            io.stdout(JSON.stringify(payload, null, 2));
        }

        if (isSuccessEnvelope(payload)) {
            if (!parsed.json) {
                io.stdout(formatStatusHumanReadable(payload.data));
            }
        } else {
            if (!parsed.json) {
                io.stderr(`Local my-websearch daemon returned an error: ${formatEnvelopeError(payload)}`);
                if (payload.hint) {
                    io.stderr(payload.hint);
                }
            }
            return 1;
        }

        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (parsed.json) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                'daemon_unavailable',
                `Local my-websearch daemon is not reachable: ${message}`,
                {
                    retryable: true,
                    hint: 'Run `my-websearch serve` first, or point `--base-url` to a reachable daemon.'
                }
            ), null, 2));
        } else {
            io.stderr(`Local my-websearch daemon is not reachable: ${message}`);
            io.stderr('Run `my-websearch serve` first, or point `--base-url` to a reachable daemon.');
        }
        return 1;
    }
}
