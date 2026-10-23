import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';
import { createErrorEnvelope } from './protocol.js';
import { ErrorCode } from '../core/errors.js';
import { CliIo, CommandContext, RunCliOptions } from './shared.js';
import { handleSearchCommand } from './commands/search.js';
import { handleFetchWebCommand } from './commands/fetchWeb.js';
import { handleFetchGithubCommand } from './commands/fetchGithub.js';
import { handleFetchCsdnCommand, handleFetchJuejinCommand } from './commands/fetchArticle.js';
import { handleResolveLibraryCommand, handleQueryDocsCommand } from './commands/docs.js';
import { handleDoctorCommand } from './commands/doctor.js';
import { handleCacheClearCommand } from './commands/cache.js';
import { handleServeCommand } from './commands/serve.js';
import { handleStatusCommand } from './commands/status.js';
import { handleInitCommand } from './commands/init.js';

// Re-export shared types and parsers for backward compatibility
export type { CliIo, RunCliOptions };
export { requireFlagValue } from './shared.js';
export { parseSearchArgs, type ParsedSearchArgs } from './commands/search.js';
export { parseFetchWebArgs, type ParsedFetchWebArgs } from './commands/fetchWeb.js';
export { parseFetchGithubArgs, type ParsedFetchGithubArgs } from './commands/fetchGithub.js';
export { parseResolveLibraryArgs, type ParsedResolveLibraryArgs, parseQueryDocsArgs, type ParsedQueryDocsArgs } from './commands/docs.js';
export { parseStatusArgs, type ParsedStatusArgs } from './commands/status.js';
export { parseServeArgs, type ParsedServeArgs } from './commands/serve.js';
export { parseInitArgs, type ParsedInitArgs } from './commands/init.js';

const COMMANDS_REQUIRING_RUNTIME = new Set([
    'search',
    'fetch-web',
    'fetch-github-content',
    'fetch-github-readme',
    'fetch-csdn',
    'fetch-juejin',
    'resolve-library-id',
    'query-docs',
    'cache-clear',
    'doctor',
    'serve'
]);

const MCP_TO_CLI_COMMAND_HINTS: Record<string, string> = {
    fetchWebContent: 'fetch-web',
    fetchGithubContent: 'fetch-github-content',
    fetchGithubReadme: 'fetch-github-readme',
    fetchCsdnArticle: 'fetch-csdn',
    fetchJuejinArticle: 'fetch-juejin',
    resolveLibraryId: 'resolve-library-id',
    queryDocs: 'query-docs'
};

export function commandNeedsRuntime(argv: string[]): boolean {
    const [command] = argv;
    if (!command) {
        return false;
    }

    return COMMANDS_REQUIRING_RUNTIME.has(command);
}

function formatCliHelp(): string {
    return [
        'my-websearch CLI',
        '',
        'Setup:',
        '  my-websearch init [--client claude-desktop,cursor,vscode|all] [--dry-run] [--force] [--json] [--home DIR]',
        '    Detect installed MCP clients and write the server entry into their config files.',
        '    Auto-detects by default; --dry-run prints the diff without writing, --force overwrites a differing existing entry (a .bak backup is kept).',
        '',
        'Daemon control & diagnostics:',
        '  my-websearch serve [--host HOST] [--port PORT]',
        '    Start the local daemon in the foreground.',
        '  my-websearch status [--base-url URL] [--json]',
        '    Check daemon status. `status` uses --base-url, not --daemon-url.',
        '  my-websearch doctor [--network] [--browser] [--engine a,b] [--reset-health] [--json]',
        '    Inspect effective configuration, config sources, proxy connectivity, browser availability/launch, and engine status (with secrets masked). `--reset-health` resets internal circuit breakers and caches before running.',
        '',
        'One-shot action commands:',
        '  my-websearch search <query> [--limit N] [--engine NAME] [--engines a,b] [--search-mode MODE] [--min-results N] [--time-range day|week|month|year] [--daemon-url URL] [--spawn] [--json]',
        '    Search the web. `--search-mode` is request|auto|playwright and affects engines supporting browser rendering (Bing, Startpage). `--min-results N` auto-runs additional engines when fewer than N results come back. `--time-range` filters to recently published results.',
        '  my-websearch cache-clear [--daemon-url URL] [--spawn] [--json]',
        '    Clear the search TTL cache (engine just recovered, stale results cached, etc.).',
        '  my-websearch fetch-web <url> [--max-chars N] [--readability] [--include-links] [--raw] [--start-index N] [--format text|markdown] [--selector CSS] [--retain-links all|none|text] [--focus KW] [--focus-mode bm25|window] [--citations] [--extract JSON] [--daemon-url URL] [--spawn] [--json]',
        '    Fetch readable page content. `--readability` enables Mozilla Readability extraction; `--include-links` returns preserved article links; `--raw` returns the raw response body; `--start-index N` continues reading from character offset N; `--format` selects output format (text or markdown).',
        '    `--selector CSS` scopes extraction to the matched subtree (keeps code/tables, errors if nothing matches); `--retain-links` drops URLs to save tokens on index pages; `--focus KW` targets a section (bm25 ranks paragraphs by relevance by default; `--focus-mode window` keeps the old fixed window). `--citations` rewrites links to numbered references. `--extract JSON` takes a CSS-selector schema and returns structured JSON instead of markdown.',
        '  my-websearch fetch-github-content <url> [--daemon-url URL] [--spawn] [--json]',
        '    Read GitHub/Gitee README, one source file (/blob/), directory tree (/tree/), Issue, or PR. Alias: fetch-github-readme.',
        '    GitHub: /pull/42 ; Gitee: /pulls/4. Examples: https://github.com/o/r/blob/main/README.md , https://gitee.com/o/r/blob/master/README.md',
        '  my-websearch fetch-csdn <url> [--daemon-url URL] [--spawn] [--json]',
        '  my-websearch fetch-juejin <url> [--daemon-url URL] [--spawn] [--json]',
        '  my-websearch resolve-library-id <name> [--query QUERY] [--limit N] [--daemon-url URL] [--spawn] [--json]',
        '    Resolve a library/package name to a Context7 library ID (e.g. /vercel/next.js).',
        '  my-websearch query-docs <library> [--query QUERY] [--limit N] [--daemon-url URL] [--spawn] [--json]',
        '    Get official documentation and code snippets for any library or Context7 ID (e.g. next.js or /vercel/next.js).',
        '',
        'Common action flags:',
        '  --daemon-url URL',
        '    Use a specific daemon for search/fetch commands and disable silent fallback to direct execution.',
        '  --spawn',
        '    If the target daemon is not reachable, start a local daemon automatically and retry the action.',
        '  --json',
        '    Output only the structured JSON envelope for scripting or agent use.',
        '',
        'Execution model:',
        '  - Use `my-websearch serve` to start the local daemon.',
        '  - Use `my-websearch status` to check daemon status.',
        '  - `status` uses --base-url. Action commands such as `search` and `fetch-web` use --daemon-url.',
        '  - Action commands try the default local daemon first when available.',
        '  - `--daemon-url` makes the daemon path explicit and disables silent fallback to direct execution.',
        '  - Bare `my-websearch` starts the MCP server compatibility path, not the recommended daemon path.',
        '  - MCP tool names differ from CLI commands. For example:',
        '      fetchWebContent -> fetch-web',
        '      fetchGithubContent -> fetch-github-content (alias: fetch-github-readme)',
        '      resolveLibraryId -> resolve-library-id',
        '      queryDocs -> query-docs'
    ].join('\n');
}

function getUnknownCommandMessage(command: string): string {
    const mapped = MCP_TO_CLI_COMMAND_HINTS[command];
    if (mapped) {
        return `Unknown CLI command: ${command}. Did you mean \`${mapped}\`?`;
    }

    return `Unknown CLI command: ${command}`;
}

export async function runCli(
    argv: string[],
    runtime: MyWebSearchRuntime,
    io: CliIo,
    options: RunCliOptions = {}
): Promise<number | null> {
    const [first, ...rest] = argv;
    if (!first) {
        return null;
    }
    const command = first;

    if (command === '--help' || command === '-h' || command === 'help') {
        io.stdout(formatCliHelp());
        return 0;
    }

    const ctx: CommandContext = {
        argv: rest,
        io,
        runtime,
        options
    };

    switch (command) {
        case 'init':
            return handleInitCommand(ctx);
        case 'search':
            return handleSearchCommand(ctx);
        case 'doctor':
            return handleDoctorCommand(ctx);
        case 'cache-clear':
            return handleCacheClearCommand(ctx);
        case 'fetch-web':
            return handleFetchWebCommand(ctx);
        case 'fetch-github-readme':
        case 'fetch-github-content':
            return handleFetchGithubCommand(ctx, command);
        case 'fetch-csdn':
            return handleFetchCsdnCommand(ctx);
        case 'fetch-juejin':
            return handleFetchJuejinCommand(ctx);
        case 'resolve-library-id':
            return handleResolveLibraryCommand(ctx);
        case 'query-docs':
            return handleQueryDocsCommand(ctx);
        case 'status':
            return handleStatusCommand(ctx);
        case 'serve':
            return handleServeCommand(ctx);
        default: {
            const unknownCommandMessage = getUnknownCommandMessage(command);
            const unknownCommandHint = [
                'Use `my-websearch --help` to see CLI commands.',
                'MCP tool names are not always the same as CLI commands.'
            ].join(' ');

            if (rest.includes('--json')) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    ErrorCode.INVALID_ARGUMENTS,
                    unknownCommandMessage,
                    {
                        hint: unknownCommandHint
                    }
                ), null, 2));
            } else {
                io.stderr(unknownCommandMessage);
                io.stderr(unknownCommandHint);
            }
            return 1;
        }
    }
}
