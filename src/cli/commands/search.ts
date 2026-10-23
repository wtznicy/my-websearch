import { normalizeEngineName, resolveRequestedEngines, SupportedSearchEngine } from '../../core/search/searchEngines.js';
import { pickDefaultEnginesForQuery } from '../../core/search/queryEngineRouting.js';
import { isKnownUnreachableOverseasEngine } from '../../utils/overseasProbe.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { AppConfig } from '../../config.js';
import { createErrorEnvelope, createSuccessEnvelope } from '../protocol.js';
import { ErrorCode } from '../../core/errors.js';
import {
    CommandContext,
    DaemonTransportArgs,
    extractDaemonTransportArgs,
    getDaemonCliErrorCode,
    getDaemonCliErrorHint,
    getDaemonCliErrorLabel,
    isFlag,
    isSuccessEnvelope,
    requireFlagValue,
    tryDaemonRequest
} from '../shared.js';

export type ParsedSearchArgs = {
    query: string;
    limit: number;
    limitExplicit?: boolean;
    engines: SupportedSearchEngine[];
    enginesExplicit?: boolean;
    searchMode?: AppConfig['searchMode'];
    /** 结果数低于此值时自动用其他引擎补位（0 = 不启用） */
    minResults: number;
    minResultsExplicit?: boolean;
    timeRange?: 'day' | 'week' | 'month' | 'year';
    json: boolean;
};

export function parseSearchArgs(argv: string[], runtime: MyWebSearchRuntime): ParsedSearchArgs {
    const positional: string[] = [];
    const requestedEngines: string[] = [];
    let limit: number | undefined;
    let searchMode: AppConfig['searchMode'] | undefined;
    let minResults: number | undefined;
    let timeRange: 'day' | 'week' | 'month' | 'year' | undefined;
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

        if (arg === '--limit') {
            limit = Number(requireFlagValue(argv, index, '--limit'));
            index += 1;
            continue;
        }

        if (arg === '--engine') {
            requestedEngines.push(normalizeEngineName(requireFlagValue(argv, index, '--engine')));
            index += 1;
            continue;
        }

        if (arg === '--engines') {
            const next = requireFlagValue(argv, index, '--engines');
            requestedEngines.push(...next.split(',').map((value) => normalizeEngineName(value.trim())).filter(Boolean));
            index += 1;
            continue;
        }

        if (arg === '--search-mode') {
            const next = requireFlagValue(argv, index, '--search-mode');
            if (next !== 'request' && next !== 'auto' && next !== 'playwright') {
                throw new Error('search mode must be one of: request, auto, playwright');
            }
            searchMode = next;
            index += 1;
            continue;
        }

        if (arg === '--min-results') {
            const parsed = Number(requireFlagValue(argv, index, '--min-results'));
            if (!Number.isInteger(parsed) || parsed < 0) {
                throw new Error('--min-results must be a non-negative integer');
            }
            minResults = parsed;
            index += 1;
            continue;
        }

        if (arg === '--time-range') {
            const next = requireFlagValue(argv, index, '--time-range');
            if (next !== 'day' && next !== 'week' && next !== 'month' && next !== 'year') {
                throw new Error('--time-range must be one of: day, week, month, year');
            }
            timeRange = next;
            index += 1;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        positional.push(arg);
    }

    const query = positional.join(' ').trim();
    if (!query) {
        throw new Error('Search query is required');
    }
    if (query.length > 500) {
        throw new Error(`Search query too long (${query.length} characters, max 500)`);
    }

    const limitExplicit = limit !== undefined;
    const minResultsExplicit = minResults !== undefined;
    const effectiveLimit = limit ?? runtime.config.defaultSearchLimit ?? 10;
    const effectiveMinResults = minResults ?? Math.min(effectiveLimit, runtime.config.defaultMinResults ?? 0);

    if (!Number.isInteger(effectiveLimit) || effectiveLimit < 1 || effectiveLimit > 50) {
        throw new Error('Limit must be an integer between 1 and 50');
    }

    const resolveDefaultEngines = (queryText: string): SupportedSearchEngine[] => {
        const picked = pickDefaultEnginesForQuery(queryText, runtime.config.defaultSearchEngine, {
            en: runtime.config.autoRouteEnEngines,
            zh: runtime.config.autoRouteZhEngines
        });
        const reachable = picked.filter((engine) => !isKnownUnreachableOverseasEngine(engine));
        const routable = reachable.length > 0 ? reachable : picked;
        const allowed = runtime.config.allowedSearchEngines;
        const filtered = allowed && allowed.length > 0 ? routable.filter((engine) => allowed.includes(engine)) : routable;
        if (filtered.length > 0) {
            return filtered as SupportedSearchEngine[];
        }
        return (allowed && allowed.length > 0 && allowed[0] ? [allowed[0]] : routable) as SupportedSearchEngine[];
    };

    const defaultEngines = resolveDefaultEngines(query);
    const fallbackEngine = defaultEngines[0] || 'bing';

    const normalizedRequestedEngines = requestedEngines.length > 0
        ? requestedEngines.flatMap((engine) => (engine === 'auto' ? defaultEngines : [engine]))
        : defaultEngines;
    const resolvedEngines = resolveRequestedEngines(
        normalizedRequestedEngines,
        runtime.config.allowedSearchEngines,
        fallbackEngine
    ) as SupportedSearchEngine[];

    return {
        query,
        limit: effectiveLimit,
        limitExplicit,
        engines: resolvedEngines,
        enginesExplicit: requestedEngines.length > 0,
        searchMode,
        minResults: effectiveMinResults,
        minResultsExplicit,
        timeRange,
        json
    };
}

export function formatSearchHumanReadable(result: Awaited<ReturnType<MyWebSearchRuntime['services']['search']['execute']>>): string {
    const lines = [
        `Search completed for "${result.query}"`,
        `Outcome: ${result.outcome ?? 'ok'}`,
        `Engines: ${result.engines.join(', ')}`,
        `Results: ${result.totalResults}`
    ];

    if (result.cascadedEngines && result.cascadedEngines.length > 0) {
        lines.push(`Cascaded engines: ${result.cascadedEngines.join(', ')}`);
    }

    if (result.partialFailures.length > 0) {
        lines.push(`Partial failures: ${result.partialFailures.length}`);
    }

    result.results.forEach((item, index) => {
        lines.push('');
        lines.push(`${index + 1}. ${item.title}`);
        lines.push(`   ${item.url}`);
        lines.push(`   ${item.description}`);
    });

    return lines.join('\n');
}

export async function handleSearchCommand(ctx: CommandContext): Promise<number> {
    const { argv: rest, io, runtime, options } = ctx;
    let transport: DaemonTransportArgs;
    let parsed: ParsedSearchArgs;
    try {
        transport = extractDaemonTransportArgs(rest);
        parsed = parseSearchArgs(transport.argv, runtime);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rest.includes('--json')) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: 'Use `my-websearch search <query> [--limit N] [--engine NAME] [--search-mode MODE] [--time-range day|week|month|year] [--json]`.' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch search <query> [--limit N] [--engine NAME] [--engines a,b] [--search-mode MODE] [--time-range day|week|month|year] [--json]');
        }
        return 1;
    }

    try {
        const daemonResult = await tryDaemonRequest<Awaited<ReturnType<MyWebSearchRuntime['services']['search']['execute']>>>(
            transport,
            '/search',
            {
                query: parsed.query,
                engines: parsed.enginesExplicit ? parsed.engines : undefined,
                limit: parsed.limitExplicit ? parsed.limit : undefined,
                searchMode: parsed.searchMode,
                minResults: parsed.minResultsExplicit ? parsed.minResults : undefined,
                ...(parsed.timeRange ? { timeRange: parsed.timeRange } : {})
            },
            options
        );
        if (daemonResult) {
            if (parsed.json) {
                io.stdout(JSON.stringify(daemonResult, null, 2));
            } else if (isSuccessEnvelope(daemonResult)) {
                io.stdout(formatSearchHumanReadable(daemonResult.data));
            } else {
                io.stderr(`Search failed: ${daemonResult.error?.message ?? 'Unknown error'}`);
                if (daemonResult.hint) {
                    io.stderr(daemonResult.hint);
                }
            }
            return daemonResult.status === 'ok' ? 0 : 1;
        }

        const result = await runtime.services.search.execute({
            query: parsed.query,
            engines: parsed.engines,
            limit: parsed.limit,
            searchMode: parsed.searchMode,
            minResults: parsed.minResults,
            ...(parsed.timeRange ? { timeRange: parsed.timeRange } : {}),
            // 显式 --engines 时把原集合传下去：级联只能在用户点名的引擎里补位，
            // 而不是悄悄把 duckduckgo/brave 也拉进来（实测 --engines github 跑了 6 个引擎、22s）
            ...(parsed.enginesExplicit ? { requestedEngines: [...parsed.engines] } : {})
        });

        if (result.outcome === 'failed') {
            const failureSummary = result.partialFailures
                .map((failure) => `${failure.engine}: ${failure.message}`)
                .join('; ') || 'All search engines failed';
            const hint = 'Retry with a different engine (`--engine` / `engines`), inspect proxy/network status with `my-websearch doctor`, or try again later.';
            if (parsed.json) {
                io.stdout(JSON.stringify(createErrorEnvelope(
                    ErrorCode.ENGINE_ERROR,
                    failureSummary,
                    {
                        retryable: result.retryable ?? true,
                        data: result,
                        details: {
                            outcome: result.outcome,
                            engines: result.engines,
                            partialFailures: result.partialFailures
                        },
                        hint
                    }
                ), null, 2));
            } else {
                io.stderr(`Search failed for "${result.query}" (retryable: ${result.retryable ? 'yes' : 'no'}): ${failureSummary}`);
                io.stderr(hint);
            }
            return 1;
        }

        if (parsed.json) {
            io.stdout(JSON.stringify(createSuccessEnvelope(result), null, 2));
        } else {
            io.stdout(formatSearchHumanReadable(result));
        }
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (parsed.json) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                getDaemonCliErrorCode(error),
                message,
                { hint: getDaemonCliErrorHint(error) }
            ), null, 2));
        } else {
            io.stderr(`${getDaemonCliErrorLabel(error, 'Search failed')}: ${message}`);
        }
        return 1;
    }
}
