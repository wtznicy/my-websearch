import { createErrorEnvelope, createSuccessEnvelope } from '../protocol.js';
import { ErrorCode, isAppError } from '../../core/errors.js';
import {
    CommandContext,
    DaemonTransportArgs,
    extractDaemonTransportArgs,
    getDaemonCliErrorCode,
    getDaemonCliErrorHint,
    getDaemonCliErrorLabel,
    isDaemonRequestError,
    isFlag,
    isSuccessEnvelope,
    tryDaemonRequest
} from '../shared.js';

export type ParsedFetchGithubArgs = {
    url: string;
    json: boolean;
};

export function parseFetchGithubArgs(argv: string[]): ParsedFetchGithubArgs {
    const positional: string[] = [];
    let json = false;

    for (const arg of argv) {
        if (arg === '--json') {
            json = true;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        positional.push(arg);
    }

    const url = positional.join(' ').trim();
    if (!url) {
        throw new Error('Target URL is required');
    }

    return {
        url,
        json
    };
}

export function formatGithubReadmeHumanReadable(url: string, content: string): string {
    return `Fetched GitHub README from ${url}\n\n${content}`;
}

export async function handleFetchGithubCommand(ctx: CommandContext, commandName: string): Promise<number> {
    const { argv: rest, io, runtime, options } = ctx;
    let transport: DaemonTransportArgs;
    let parsed: ParsedFetchGithubArgs;
    try {
        transport = extractDaemonTransportArgs(rest);
        parsed = parseFetchGithubArgs(transport.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rest.includes('--json')) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: `Use \`my-websearch ${commandName} <repository-url> [--json]\`.` }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr(`Usage: my-websearch ${commandName} <repository-url> [--json]`);
        }
        return 1;
    }

    try {
        const daemonResult = await tryDaemonRequest<{ url: string; content: string }>(
            transport,
            '/fetch-github-readme',
            { url: parsed.url },
            options
        );
        if (daemonResult) {
            if (parsed.json) {
                io.stdout(JSON.stringify(daemonResult, null, 2));
            } else if (isSuccessEnvelope(daemonResult)) {
                io.stdout(formatGithubReadmeHumanReadable(daemonResult.data.url, daemonResult.data.content));
            } else {
                io.stderr(daemonResult.error?.message ?? 'README not found or repository does not exist');
                if (daemonResult.hint) {
                    io.stderr(daemonResult.hint);
                }
            }
            return daemonResult.status === 'ok' ? 0 : 1;
        }

        const result = await runtime.services.fetchGithubReadme.execute({ url: parsed.url });
        if (!result) {
            if (parsed.json) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    ErrorCode.NOT_FOUND,
                    'Content not found or repository/item does not exist',
                    { hint: 'Use /blob/<ref>/<path> for a file, /tree/<ref>/<path> for a directory, /issues/<n>, or /pull/<n>; ref may be a branch, tag, or commit.' }
                ), null, 2));
            } else {
                io.stderr('Content not found or repository/item does not exist');
            }
            return 1;
        }

        if (parsed.json) {
            io.stdout(JSON.stringify(createSuccessEnvelope({
                url: parsed.url,
                content: result
            }), null, 2));
        } else {
            io.stdout(formatGithubReadmeHumanReadable(parsed.url, result));
        }
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (parsed.json) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                isDaemonRequestError(error)
                    ? getDaemonCliErrorCode(error)
                    : (isAppError(error) ? error.code : ErrorCode.INVALID_ARGUMENTS),
                message,
                { hint: isDaemonRequestError(error)
                    ? getDaemonCliErrorHint(error)
                    : (isAppError(error) && error.hint
                        ? error.hint
                        : 'Use a valid GitHub repository URL in HTTPS or SSH form.') }
            ), null, 2));
        } else {
            io.stderr(`${getDaemonCliErrorLabel(error, 'Fetch failed')}: ${message}`);
        }
        return 1;
    }
}
