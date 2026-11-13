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
import { parseGitHubRepoSpec } from '../../engines/github/githubSearch.js';
import { searchGithubSymbol, formatSymbolSearchResult } from '../../engines/github/githubSymbolSearch.js';

export type ParsedFetchGithubArgs = {
    url: string;
    json: boolean;
    symbol?: string;
    ref?: string;
    lines?: string;
    maxResults?: number;
    releaseLimit?: number;
};

export function parseFetchGithubArgs(argv: string[]): ParsedFetchGithubArgs {
    const positional: string[] = [];
    let json = false;
    let symbol: string | undefined;
    let ref: string | undefined;
    let lines: string | undefined;
    let maxResults: number | undefined;
    let releaseLimit: number | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] ?? '';
        if (arg === '--json') {
            json = true;
            continue;
        }

        if (arg === '--symbol' || arg === '-s') {
            const val = argv[++i];
            if (!val) throw new Error('Missing value for --symbol');
            symbol = val;
            continue;
        }
        if (arg.startsWith('--symbol=')) {
            symbol = arg.slice(9);
            continue;
        }

        if (arg === '--ref' || arg === '-r') {
            const val = argv[++i];
            if (!val) throw new Error('Missing value for --ref');
            ref = val;
            continue;
        }
        if (arg.startsWith('--ref=')) {
            ref = arg.slice(6);
            continue;
        }

        if (arg === '--lines' || arg === '-l') {
            const val = argv[++i];
            if (!val) throw new Error('Missing value for --lines');
            lines = val;
            continue;
        }
        if (arg.startsWith('--lines=')) {
            lines = arg.slice(8);
            continue;
        }

        if (arg === '--max-results') {
            const val = argv[++i];
            if (!val) throw new Error('Missing value for --max-results');
            const num = Number(val);
            if (Number.isNaN(num) || num < 1 || num > 20) throw new Error('--max-results must be an integer between 1 and 20');
            maxResults = num;
            continue;
        }
        if (arg.startsWith('--max-results=')) {
            const num = Number(arg.slice(14));
            if (Number.isNaN(num) || num < 1 || num > 20) throw new Error('--max-results must be an integer between 1 and 20');
            maxResults = num;
            continue;
        }

        if (arg === '--release-limit') {
            const val = argv[++i];
            if (!val) throw new Error('Missing value for --release-limit');
            const num = Number(val);
            if (Number.isNaN(num) || num < 1 || num > 30) throw new Error('--release-limit must be an integer between 1 and 30');
            releaseLimit = num;
            continue;
        }
        if (arg.startsWith('--release-limit=')) {
            const num = Number(arg.slice(16));
            if (Number.isNaN(num) || num < 1 || num > 30) throw new Error('--release-limit must be an integer between 1 and 30');
            releaseLimit = num;
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
        json,
        symbol,
        ref,
        lines,
        maxResults,
        releaseLimit
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
                { hint: `Use \`my-websearch ${commandName} <repository-url> [--symbol <name>] [--lines <n-m>] [--ref <branch>] [--json]\`.` }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr(`Usage: my-websearch ${commandName} <repository-url> [--symbol <name>] [--lines <n-m>] [--ref <branch>] [--json]`);
        }
        return 1;
    }

    try {
        // 分支 1：代码符号搜索模式
        if (parsed.symbol?.trim()) {
            const symbolResult = await searchGithubSymbol({
                urlOrRepo: parsed.url,
                symbol: parsed.symbol.trim(),
                ref: parsed.ref,
                maxResults: parsed.maxResults
            });
            if (parsed.json) {
                io.stdout(JSON.stringify(createSuccessEnvelope(symbolResult), null, 2));
            } else {
                io.stdout(formatSymbolSearchResult(symbolResult));
            }
            return 0;
        }

        // 分支 2：普通内容模式（README, blob, tree, issue, PR, releases）
        let targetUrl = parsed.url.trim();
        const repoSpec = parseGitHubRepoSpec(targetUrl);
        if (repoSpec && !/^(?:https?:\/\/|git@)/i.test(targetUrl)) {
            targetUrl = `https://github.com/${repoSpec.owner}/${repoSpec.repo}`;
        }

        // 仅在无复杂参数时走简单 daemon 请求，否则走本地服务
        if (!parsed.lines && !parsed.releaseLimit) {
            const daemonResult = await tryDaemonRequest<{ url: string; content: string }>(
                transport,
                '/fetch-github-readme',
                { url: targetUrl },
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
        }

        const result = await runtime.services.fetchGithubReadme.execute({
            url: targetUrl,
            lines: parsed.lines,
            releaseLimit: parsed.releaseLimit
        });
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
                url: targetUrl,
                content: result
            }), null, 2));
        } else {
            io.stdout(formatGithubReadmeHumanReadable(targetUrl, result));
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
