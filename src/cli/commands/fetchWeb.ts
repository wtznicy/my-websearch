import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { createErrorEnvelope, createSuccessEnvelope } from '../protocol.js';
import { ErrorCode, isAppError } from '../../core/errors.js';
import { validateExtractSchema, type ExtractSchema } from '../../engines/web/extract.js';
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

export type ParsedFetchWebArgs = {
    url: string;
    maxChars: number;
    readability: boolean;
    includeLinks: boolean;
    raw: boolean;
    startIndex: number;
    format?: 'text' | 'markdown';
    focus?: string;
    focusMode?: 'bm25' | 'window';
    citations: boolean;
    retainLinks?: 'all' | 'none' | 'text';
    selector?: string;
    extract?: ExtractSchema;
    json: boolean;
};

export function parseFetchWebArgs(argv: string[]): ParsedFetchWebArgs {
    const positional: string[] = [];
    let maxChars = 30000;
    let readability = false;
    let includeLinks = false;
    let raw = false;
    let startIndex = 0;
    let format: 'text' | 'markdown' | undefined;
    let focus: string | undefined;
    let focusMode: 'bm25' | 'window' | undefined;
    let citations = false;
    let retainLinks: 'all' | 'none' | 'text' | undefined;
    let selector: string | undefined;
    let extract: ExtractSchema | undefined;
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

        if (arg === '--max-chars') {
            maxChars = Number(requireFlagValue(argv, index, '--max-chars'));
            index += 1;
            continue;
        }

        if (arg === '--readability') {
            readability = true;
            continue;
        }

        if (arg === '--include-links') {
            includeLinks = true;
            continue;
        }

        if (arg === '--raw') {
            raw = true;
            continue;
        }

        if (arg === '--start-index') {
            startIndex = Number(requireFlagValue(argv, index, '--start-index'));
            index += 1;
            continue;
        }

        if (arg === '--format') {
            const next = requireFlagValue(argv, index, '--format');
            if (next !== 'text' && next !== 'markdown') {
                throw new Error('format must be one of: text, markdown');
            }
            format = next;
            index += 1;
            continue;
        }

        if (arg === '--focus') {
            const next = requireFlagValue(argv, index, '--focus').trim();
            if (!next) {
                throw new Error('focus must be a non-empty string');
            }
            focus = next;
            index += 1;
            continue;
        }

        if (arg === '--focus-mode') {
            const next = requireFlagValue(argv, index, '--focus-mode');
            if (next !== 'bm25' && next !== 'window') {
                throw new Error('focusMode must be one of: bm25, window');
            }
            focusMode = next;
            index += 1;
            continue;
        }

        if (arg === '--citations') {
            citations = true;
            continue;
        }

        if (arg === '--retain-links') {
            const next = requireFlagValue(argv, index, '--retain-links');
            if (next !== 'all' && next !== 'none' && next !== 'text') {
                throw new Error('retainLinks must be one of: all, none, text');
            }
            retainLinks = next;
            index += 1;
            continue;
        }

        if (arg === '--selector') {
            const next = requireFlagValue(argv, index, '--selector').trim();
            if (!next) {
                throw new Error('selector must be a non-empty CSS selector');
            }
            selector = next;
            index += 1;
            continue;
        }

        if (arg === '--extract') {
            const next = requireFlagValue(argv, index, '--extract');
            let parsedSchema: unknown;
            try {
                parsedSchema = JSON.parse(next);
            } catch {
                throw new Error('--extract must be a JSON object, e.g. \'{"baseSelector":"div.item","fields":[{"name":"title","selector":"h2"}]}\'');
            }
            extract = validateExtractSchema(parsedSchema);
            index += 1;
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
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
    } catch {
        throw new Error('Invalid URL format');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`Only http and https protocols are supported (received: "${parsedUrl.protocol}")`);
    }
    // CLI 下限放宽到 100（MCP 工具 schema 仍保持 1000，这里只影响命令行直接调用，
    // 方便临时抓取小片段文本）；上限与 MCP 保持一致
    if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 200000) {
        throw new Error('maxChars must be an integer between 100 and 200000');
    }
    if (!Number.isInteger(startIndex) || startIndex < 0) {
        throw new Error('startIndex must be a non-negative integer');
    }

    return {
        url,
        maxChars,
        readability,
        includeLinks,
        raw,
        startIndex,
        format,
        ...(focus ? { focus } : {}),
        ...(focusMode ? { focusMode } : {}),
        citations,
        ...(retainLinks ? { retainLinks } : {}),
        ...(selector ? { selector } : {}),
        ...(extract ? { extract } : {}),
        json
    };
}

export function formatFetchWebHumanReadable(result: Awaited<ReturnType<MyWebSearchRuntime['services']['fetchWeb']['execute']>>): string {
    const lines = [
        `Fetched web content from ${result.finalUrl}`,
        `Title: ${result.title ?? '(none)'}`,
        `Content-Type: ${result.contentType}`,
        `Retrieval: ${result.retrievalMethod}`,
        `Readability: ${result.readabilityApplied ? 'yes' : 'no'}`,
        `Truncated: ${result.truncated ? 'yes' : 'no'}`,
        '',
        result.content
    ];

    if (result.links && result.links.length > 0) {
        lines.push('');
        lines.push(`Links: ${result.links.length}`);
    }

    return lines.join('\n');
}

export async function handleFetchWebCommand(ctx: CommandContext): Promise<number> {
    const { argv: rest, io, runtime, options } = ctx;
    let transport: DaemonTransportArgs;
    let parsed: ParsedFetchWebArgs;
    try {
        transport = extractDaemonTransportArgs(rest);
        parsed = parseFetchWebArgs(transport.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rest.includes('--json')) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: 'Use `my-websearch fetch-web <url> [--max-chars N] [--format text|markdown] [--focus KW] [--citations] [--extract JSON] [--json]`.' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch fetch-web <url> [--max-chars N] [--readability] [--include-links] [--raw] [--start-index N] [--format text|markdown] [--selector CSS] [--retain-links all|none|text] [--focus KW] [--focus-mode bm25|window] [--citations] [--extract JSON] [--json]');
        }
        return 1;
    }

    try {
        const daemonResult = await tryDaemonRequest<Awaited<ReturnType<MyWebSearchRuntime['services']['fetchWeb']['execute']>>>(
            transport,
            '/fetch-web',
            {
                url: parsed.url,
                maxChars: parsed.maxChars,
                readability: parsed.readability,
                includeLinks: parsed.includeLinks,
                raw: parsed.raw,
                startIndex: parsed.startIndex,
                format: parsed.format,
                ...(parsed.focus ? { focus: parsed.focus } : {}),
                ...(parsed.focusMode ? { focusMode: parsed.focusMode } : {}),
                ...(parsed.citations ? { citations: true } : {}),
                ...(parsed.retainLinks ? { retainLinks: parsed.retainLinks } : {}),
                ...(parsed.selector ? { selector: parsed.selector } : {}),
                ...(parsed.extract ? { extract: parsed.extract } : {})
            },
            options
        );
        if (daemonResult) {
            if (parsed.json) {
                io.stdout(JSON.stringify(daemonResult, null, 2));
            } else if (isSuccessEnvelope(daemonResult)) {
                io.stdout(formatFetchWebHumanReadable(daemonResult.data));
            } else {
                io.stderr(`Fetch failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                if (daemonResult.hint) {
                    io.stderr(daemonResult.hint);
                }
            }
            return daemonResult.status === 'ok' ? 0 : 1;
        }

        const result = await runtime.services.fetchWeb.execute({
            url: parsed.url,
            maxChars: parsed.maxChars,
            readability: parsed.readability,
            includeLinks: parsed.includeLinks,
            raw: parsed.raw,
            startIndex: parsed.startIndex,
            format: parsed.format,
            ...(parsed.focus ? { focus: parsed.focus } : {}),
            ...(parsed.focusMode ? { focusMode: parsed.focusMode } : {}),
            ...(parsed.citations ? { citations: true } : {}),
            ...(parsed.retainLinks ? { retainLinks: parsed.retainLinks } : {}),
            ...(parsed.selector ? { selector: parsed.selector } : {}),
            ...(parsed.extract ? { extract: parsed.extract } : {})
        });

        if (parsed.json) {
            io.stdout(JSON.stringify(createSuccessEnvelope(result), null, 2));
        } else {
            io.stdout(formatFetchWebHumanReadable(result));
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
                    : (isAppError(error) && error.hint ? error.hint : 'Use a public HTTP(S) URL and keep maxChars within the supported range.') }
            ), null, 2));
        } else {
            io.stderr(`${getDaemonCliErrorLabel(error, 'Fetch failed')}: ${message}`);
        }
        return 1;
    }
}
