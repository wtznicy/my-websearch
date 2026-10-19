import { createErrorEnvelope, createSuccessEnvelope } from '../protocol.js';
import { ErrorCode } from '../../core/errors.js';
import {
    CommandContext,
    DaemonTransportArgs,
    extractDaemonTransportArgs,
    getDaemonCliErrorCode,
    getDaemonCliErrorHint,
    getDaemonCliErrorLabel,
    isDaemonRequestError,
    isSuccessEnvelope,
    tryDaemonRequest
} from '../shared.js';
import { parseFetchGithubArgs, ParsedFetchGithubArgs } from './fetchGithub.js';

export function formatArticleHumanReadable(label: string, url: string, content: string): string {
    return `Fetched ${label} article from ${url}\n\n${content}`;
}

export async function handleFetchCsdnCommand(ctx: CommandContext): Promise<number> {
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
                { hint: 'Use `my-websearch fetch-csdn <article-url> [--json]`.' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch fetch-csdn <article-url> [--json]');
        }
        return 1;
    }

    try {
        const daemonResult = await tryDaemonRequest<{ url: string; content: string }>(
            transport,
            '/fetch-csdn',
            { url: parsed.url },
            options
        );
        if (daemonResult) {
            if (parsed.json) {
                io.stdout(JSON.stringify(daemonResult, null, 2));
            } else if (isSuccessEnvelope(daemonResult)) {
                io.stdout(formatArticleHumanReadable('CSDN', daemonResult.data.url, daemonResult.data.content));
            } else {
                io.stderr(`Fetch failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                if (daemonResult.hint) {
                    io.stderr(daemonResult.hint);
                }
            }
            return daemonResult.status === 'ok' ? 0 : 1;
        }

        const result = await runtime.services.fetchCsdnArticle.execute({ url: parsed.url });
        if (parsed.json) {
            io.stdout(JSON.stringify(createSuccessEnvelope({
                url: parsed.url,
                content: result.content
            }), null, 2));
        } else {
            io.stdout(formatArticleHumanReadable('CSDN', parsed.url, result.content));
        }
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (parsed.json) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                isDaemonRequestError(error) ? getDaemonCliErrorCode(error) : ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: isDaemonRequestError(error)
                    ? getDaemonCliErrorHint(error)
                    : 'Use a valid blog.csdn.net article URL.' }
            ), null, 2));
        } else {
            io.stderr(`${getDaemonCliErrorLabel(error, 'Fetch failed')}: ${message}`);
        }
        return 1;
    }
}

export async function handleFetchJuejinCommand(ctx: CommandContext): Promise<number> {
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
                { hint: 'Use `my-websearch fetch-juejin <article-url> [--json]`.' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch fetch-juejin <article-url> [--json]');
        }
        return 1;
    }

    try {
        const daemonResult = await tryDaemonRequest<{ url: string; content: string }>(
            transport,
            '/fetch-juejin',
            { url: parsed.url },
            options
        );
        if (daemonResult) {
            if (parsed.json) {
                io.stdout(JSON.stringify(daemonResult, null, 2));
            } else if (isSuccessEnvelope(daemonResult)) {
                io.stdout(formatArticleHumanReadable('Juejin', daemonResult.data.url, daemonResult.data.content));
            } else {
                io.stderr(`Fetch failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                if (daemonResult.hint) {
                    io.stderr(daemonResult.hint);
                }
            }
            return daemonResult.status === 'ok' ? 0 : 1;
        }

        const result = await runtime.services.fetchJuejinArticle.execute({ url: parsed.url });
        if (parsed.json) {
            io.stdout(JSON.stringify(createSuccessEnvelope({
                url: parsed.url,
                content: result.content
            }), null, 2));
        } else {
            io.stdout(formatArticleHumanReadable('Juejin', parsed.url, result.content));
        }
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (parsed.json) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                isDaemonRequestError(error) ? getDaemonCliErrorCode(error) : ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: isDaemonRequestError(error)
                    ? getDaemonCliErrorHint(error)
                    : 'Use a valid juejin.cn post URL.' }
            ), null, 2));
        } else {
            io.stderr(`${getDaemonCliErrorLabel(error, 'Fetch failed')}: ${message}`);
        }
        return 1;
    }
}
