import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
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
    isFlag,
    isSuccessEnvelope,
    requireFlagValue,
    tryDaemonRequest
} from '../shared.js';

export type ParsedResolveLibraryArgs = {
    libraryName: string;
    query?: string;
    limit?: number;
    json: boolean;
};

export function parseResolveLibraryArgs(argv: string[]): ParsedResolveLibraryArgs {
    const positional: string[] = [];
    let query: string | undefined;
    let limit: number | undefined;
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

        if (arg === '--query') {
            query = requireFlagValue(argv, index, '--query');
            index += 1;
            continue;
        }

        if (arg === '--limit') {
            limit = Number(requireFlagValue(argv, index, '--limit'));
            index += 1;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        positional.push(arg);
    }

    const libraryName = positional.join(' ').trim();
    if (!libraryName) {
        throw new Error('libraryName is required');
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 10)) {
        throw new Error('Limit must be an integer between 1 and 10');
    }

    return {
        libraryName,
        query,
        limit,
        json
    };
}

export type ParsedQueryDocsArgs = {
    library: string;
    libraryId: string;
    query?: string;
    limit?: number;
    json: boolean;
};

export function parseQueryDocsArgs(argv: string[]): ParsedQueryDocsArgs {
    const positional: string[] = [];
    let query: string | undefined;
    let limit: number | undefined;
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

        if (arg === '--query') {
            query = requireFlagValue(argv, index, '--query');
            index += 1;
            continue;
        }

        if (arg === '--limit') {
            limit = Number(requireFlagValue(argv, index, '--limit'));
            index += 1;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        positional.push(arg);
    }

    const target = positional.join(' ').trim();
    if (!target) {
        throw new Error('libraryId is required (e.g. next.js or /vercel/next.js)');
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 10)) {
        throw new Error('Limit must be an integer between 1 and 10');
    }

    return {
        library: target,
        libraryId: target,
        query,
        limit,
        json
    };
}

export function formatResolveLibraryHumanReadable(result: { libraryName: string; query?: string; results: Array<{ id: string; description?: string }> }): string {
    const lines = [`Resolved library matches for "${result.libraryName}":`];
    for (const item of result.results) {
        lines.push(`  - ${item.id}${item.description ? `: ${item.description}` : ''}`);
    }
    return lines.join('\n');
}

export function formatQueryDocsHumanReadable(result: {
    libraryId: string;
    resolvedFrom?: string;
    alternativeLibraries?: Array<{ id: string; title: string }>;
    snippets?: Array<{ title?: string; code?: string; content?: string }>;
    codeSnippets?: Array<{ codeTitle?: string; pageTitle?: string; codeDescription?: string; codeList?: Array<{ code: string; language?: string; path?: string }> }>;
    infoSnippets?: Array<{ title: string; content: string }>;
}): string {
    const titleHeader = result.resolvedFrom
        ? `Documentation for ${result.libraryId} (resolved from "${result.resolvedFrom}"):`
        : `Documentation for ${result.libraryId}:`;
    const lines = [titleHeader];

    if (result.alternativeLibraries && result.alternativeLibraries.length > 0) {
        lines.push(`(Alternative matches: ${result.alternativeLibraries.map(a => `${a.title} [${a.id}]`).join(', ')})`);
    }

    if (result.infoSnippets && result.infoSnippets.length > 0) {
        for (const snippet of result.infoSnippets) {
            lines.push('');
            if (snippet.title) lines.push(`### ${snippet.title}`);
            if (snippet.content) lines.push(snippet.content);
        }
    }
    if (result.codeSnippets && result.codeSnippets.length > 0) {
        for (const snippet of result.codeSnippets) {
            lines.push('');
            const heading = [snippet.pageTitle, snippet.codeTitle].filter(Boolean).join(': ') || snippet.codeTitle || 'Code Snippet';
            lines.push(`### ${heading}`);
            if (snippet.codeDescription) {
                lines.push(snippet.codeDescription);
            }
            if (snippet.codeList) {
                for (const item of snippet.codeList) {
                    const lang = item.language ?? '';
                    lines.push(`\`\`\`${lang}\n${item.code}\n\`\`\``);
                }
            }
        }
    }
    if (result.snippets && result.snippets.length > 0) {
        for (const snippet of result.snippets) {
            lines.push('');
            if (snippet.title) lines.push(`### ${snippet.title}`);
            if (snippet.content) lines.push(snippet.content);
            if (snippet.code) lines.push('```\n' + snippet.code + '\n```');
        }
    }
    return lines.join('\n');
}

export async function handleResolveLibraryCommand(ctx: CommandContext): Promise<number> {
    const { argv: rest, io, runtime, options } = ctx;
    let transport: DaemonTransportArgs;
    let parsed: ParsedResolveLibraryArgs;
    try {
        transport = extractDaemonTransportArgs(rest);
        parsed = parseResolveLibraryArgs(transport.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rest.includes('--json')) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: 'Use `my-websearch resolve-library-id <name> [--query QUERY] [--limit N] [--json]`.' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch resolve-library-id <name> [--query QUERY] [--limit N] [--json]');
        }
        return 1;
    }

    try {
        const daemonResult = await tryDaemonRequest<Awaited<ReturnType<MyWebSearchRuntime['services']['context7Libraries']['execute']>>>(
            transport,
            '/resolve-library-id',
            {
                libraryName: parsed.libraryName,
                query: parsed.query,
                limit: parsed.limit
            },
            options
        );
        if (daemonResult) {
            if (parsed.json) {
                io.stdout(JSON.stringify(daemonResult, null, 2));
            } else if (isSuccessEnvelope(daemonResult)) {
                io.stdout(formatResolveLibraryHumanReadable(daemonResult.data));
            } else {
                io.stderr(`Resolve library failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                if (daemonResult.hint) {
                    io.stderr(daemonResult.hint);
                }
            }
            return daemonResult.status === 'ok' ? 0 : 1;
        }

        const result = await runtime.services.context7Libraries.execute({
            libraryName: parsed.libraryName,
            query: parsed.query,
            limit: parsed.limit
        });
        const payload = result.query
            ? result
            : { libraryName: result.libraryName, results: result.results };

        if (parsed.json) {
            io.stdout(JSON.stringify(createSuccessEnvelope(payload), null, 2));
        } else {
            io.stdout(formatResolveLibraryHumanReadable(payload));
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
                    : 'Verify library name or check connectivity to context7.com.' }
            ), null, 2));
        } else {
            io.stderr(`${getDaemonCliErrorLabel(error, 'Resolve library failed')}: ${message}`);
        }
        return 1;
    }
}

export async function handleQueryDocsCommand(ctx: CommandContext): Promise<number> {
    const { argv: rest, io, runtime, options } = ctx;
    let transport: DaemonTransportArgs;
    let parsed: ParsedQueryDocsArgs;
    try {
        transport = extractDaemonTransportArgs(rest);
        parsed = parseQueryDocsArgs(transport.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rest.includes('--json')) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: 'Use `my-websearch query-docs <library> [--query QUERY] [--limit N] [--json]`.' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch query-docs <library> [--query QUERY] [--limit N] [--json]');
        }
        return 1;
    }

    try {
        const daemonResult = await tryDaemonRequest<Awaited<ReturnType<MyWebSearchRuntime['services']['context7Docs']['execute']>>>(
            transport,
            '/query-docs',
            {
                library: parsed.library,
                libraryId: parsed.libraryId,
                query: parsed.query,
                limit: parsed.limit
            },
            options
        );
        if (daemonResult) {
            if (parsed.json) {
                io.stdout(JSON.stringify(daemonResult, null, 2));
            } else if (isSuccessEnvelope(daemonResult)) {
                io.stdout(formatQueryDocsHumanReadable(daemonResult.data));
            } else {
                io.stderr(`Query docs failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                if (daemonResult.hint) {
                    io.stderr(daemonResult.hint);
                }
            }
            return daemonResult.status === 'ok' ? 0 : 1;
        }

        const result = await runtime.services.context7Docs.execute({
            library: parsed.library,
            query: parsed.query,
            limit: parsed.limit
        });

        if (parsed.json) {
            io.stdout(JSON.stringify(createSuccessEnvelope(result), null, 2));
        } else {
            io.stdout(formatQueryDocsHumanReadable(result));
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
                    : 'Verify libraryId or check connectivity to context7.com.' }
            ), null, 2));
        } else {
            io.stderr(`${getDaemonCliErrorLabel(error, 'Query docs failed')}: ${message}`);
        }
        return 1;
    }
}
