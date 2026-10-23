import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SearchResult } from '../../types.js';
import {
    normalizeEngineName,
    resolveRequestedEngines,
    SUPPORTED_SEARCH_ENGINES,
    SupportedSearchEngine,
    getEngineLabel
} from '../../core/search/searchEngines.js';
import { pickDefaultEnginesForQuery } from '../../core/search/queryEngineRouting.js';
import { isKnownUnreachableOverseasEngine } from '../../utils/overseasProbe.js';
import { mergeMultiQueryResults, mergeEngineMetricsAcrossQueries } from '../../core/search/multiQuery.js';
import { rankSearchResults } from '../../core/search/resultRanking.js';
import { computeSearchOutcome } from '../../core/search/searchService.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { isContext7QuotaExhausted, setContext7QuotaListener } from '../../engines/context7/context7.js';
import {
    getToolName,
    logTool,
    logSafeError,
    withErrorHint,
    TOOL_ANNOTATION_HINTS
} from '../toolShared.js';
import { detectUnknownParameters } from '../../utils/toolValidation.js';
import { createRequestContext } from '../../core/requestContext.js';

export function registerSearchTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const searchToolName = getToolName('MCP_TOOL_SEARCH_NAME', 'search');

    const DOCS_GUIDANCE = ' For OFFICIAL library/framework documentation, prefer queryDocs (more reliable, works without proxy). Use the site: operator for site-specific queries (e.g. "update site:docs.elastic.co").';
    const getDocsGuidance = () => {
        return isContext7QuotaExhausted() ? '' : DOCS_GUIDANCE;
    };
    const getSearchDescription = () => {
        return "Search the web across multiple engines (Chinese/English/Code). Supports multi-query fan-out ('queries'), timeRange filtering, site limits, fetchTop article content, and no API keys required.";
    };

    const getEnginesEnum = () => {
        const allowedEngines = runtime.config.allowedSearchEngines.length > 0
            ? runtime.config.allowedSearchEngines
            : [...SUPPORTED_SEARCH_ENGINES];

        return z.enum(allowedEngines as [string, ...string[]]);
    };

    const getEngineInputSchema = () => {
        const enginesEnum = getEnginesEnum();
        return z.string()
            .min(1, "Engine value must not be empty")
            .describe(`Search engine name. Valid values (normalize alias to canonical name): ${[...SUPPORTED_SEARCH_ENGINES].join(', ')}`)
            .transform((engine) => normalizeEngineName(engine))
            .pipe(enginesEnum);
    };

    const searchTool = server.registerTool(
        searchToolName,
        {
            description: getSearchDescription(),
            inputSchema: z.object({
                query: z.string().min(1, "Search query must not be empty").max(500, "Search query too long (max 500 characters)").optional()
                    .describe("Single search query (required if 'queries' is omitted; use 'queries' for multi-intent fan-out)"),
                queries: z.preprocess((val) => (typeof val === 'string' ? [val] : val), z.array(z.string().min(1, "Query must not be empty").max(500)).min(1).max(4).optional())
                    .describe("1-4 queries run concurrently and merged (required if 'query' is omitted)"),
                limit: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(1).max(50).optional())
                    .describe("Target total results after merging all engines (default: server DEFAULT_SEARCH_LIMIT, usually 10). Not a per-engine quota: once enough results are collected, slower engines may be cancelled (see cancelledEngines). Pass explicit `engines` to disable early cancellation."),
                searchMode: z.enum(['request', 'auto', 'playwright']).optional()
                    .describe("Execution mode: 'request' (HTTP only), 'auto' (HTTP with browser fallback), or 'playwright' (headless browser only)"),
                minResults: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(0).max(50).optional())
                    .describe("Auto-run additional engines when fewer usable results come back (default: 5 when engines omitted, 0 when engines explicitly specified)"),
                engines: z.preprocess((val) => {
                    if (typeof val === 'string') {
                        return val.split(',').map((s) => s.trim()).filter(Boolean);
                    }
                    return val;
                }, z.array(getEngineInputSchema()).min(1).optional())
                    .describe("Search engines to use (default: auto-routes by query language; explicit engines do not cascade unless minResults is specified)"),
                timeRange: z.enum(['day', 'week', 'month', 'year']).optional()
                    .describe("Publication time range filter ('day', 'week', 'month', 'year')"),
                site: z.preprocess((val) => {
                    if (typeof val === 'string') {
                        return val.split(',').map((s) => s.trim()).filter(Boolean);
                    }
                    return val;
                }, z.array(z.string()).min(1).optional())
                    .describe("Restrict search to specific site domain(s) (e.g. ['github.com', 'developer.mozilla.org'])"),
                fetchTop: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(0).max(3).optional())
                    .describe("Two-in-one search & fetch: automatically fetch full readable Markdown content for top N results (0~3) in a single turn"),
                verbose: z.boolean().optional()
                    .describe("Include verbose diagnostic fields (engineMetrics, full failure hints, and redundant source hostnames); default false to save tokens")
            }).passthrough(),
            annotations: TOOL_ANNOTATION_HINTS
        },
        async (rawArgs, extra) => {
            const { query, queries, limit, searchMode, engines, minResults, timeRange, site, fetchTop, verbose } = rawArgs as {
                query?: string;
                queries?: string[];
                limit?: number;
                searchMode?: 'request' | 'auto' | 'playwright';
                engines?: string[];
                minResults?: number;
                timeRange?: 'day' | 'week' | 'month' | 'year';
                site?: string[];
                fetchTop?: number;
                verbose?: boolean;
            } & Record<string, unknown>;
            const signal = extra?.signal;
            const requestContext = createRequestContext({ signal, timeoutMs: runtime.config.searchDeadlineMs });
            const knownSearchKeys = ['query', 'queries', 'limit', 'searchMode', 'engines', 'minResults', 'timeRange', 'site', 'fetchTop', 'verbose'];
            const unknownWarnings = detectUnknownParameters(rawArgs as Record<string, unknown>, knownSearchKeys);
            unknownWarnings.forEach((w) => requestContext.addWarning(w));

            try {
                const queryList: string[] = (queries && queries.length > 0 ? queries : (query ? [query] : [])).map((q: string) => q.trim()).filter(Boolean);
                if (queryList.length === 0) {
                    return {
                        content: [{ type: 'text', text: 'Provide either "query" or "queries" (1-4 queries).' }],
                        isError: true
                    };
                }
                const primaryQuery = queryList[0] ?? '';

                const effectiveLimit = limit ?? runtime.config.defaultSearchLimit;
                // 行为变更：显式传 engines 且未传 minResults 时，默认 minResults=0，不再级联；要级联就显式给 minResults
                const effectiveMinResults = minResults !== undefined
                    ? minResults
                    : (engines && engines.length > 0 ? 0 : Math.min(effectiveLimit, runtime.config.defaultMinResults));

                const allowed = runtime.config.allowedSearchEngines;
                const resolveEnginesForQuery = (queryText: string): SupportedSearchEngine[] => {
                    const picked = pickDefaultEnginesForQuery(queryText, runtime.config.defaultSearchEngine, {
                        en: runtime.config.autoRouteEnEngines,
                        zh: runtime.config.autoRouteZhEngines
                    });
                    const reachable = picked.filter((engine) => !isKnownUnreachableOverseasEngine(engine));
                    const routable = reachable.length > 0 ? reachable : picked;
                    const filtered = allowed.length > 0 ? routable.filter((engine) => allowed.includes(engine)) : routable;
                    if (filtered.length > 0) {
                        return filtered as SupportedSearchEngine[];
                    }
                    return (allowed.length > 0 && allowed[0] ? [allowed[0]] : routable) as SupportedSearchEngine[];
                };
                const explicitEngines = engines && engines.length > 0
                    ? resolveRequestedEngines(engines, allowed, resolveEnginesForQuery(primaryQuery)[0] || 'bing') as [SupportedSearchEngine, ...SupportedSearchEngine[]]
                    : null;
                const enginesPerQuery: SupportedSearchEngine[][] = explicitEngines
                    ? queryList.map(() => [...explicitEngines])
                    : queryList.map((q: string) => resolveEnginesForQuery(q));

                logTool(`Searching ${queryList.map((q: string, index: number) => `"${q}" [${(enginesPerQuery[index] ?? []).join(',')}]`).join(', ')}`);

                const perQueryLimit = queryList.length > 1
                    ? Math.max(3, Math.ceil(effectiveLimit / queryList.length) + 2)
                    : effectiveLimit;
                const executed = await Promise.all(queryList.map((q: string, index: number) => {
                    return runtime.services.search.execute({
                        query: q,
                        engines: enginesPerQuery[index] ?? ['bing'],
                        limit: perQueryLimit,
                        searchMode,
                        minResults: effectiveMinResults,
                        timeRange,
                        site,
                        requestedEngines: explicitEngines ? [...explicitEngines] : undefined,
                        signal,
                        requestContext
                    });
                }));

                for (const one of executed) {
                    for (const failure of one.partialFailures) {
                        logTool(`Search failed for engine ${failure.engine}: ${failure.message}`);
                    }
                }

                const mergedResults = queryList.length > 1
                    ? rankSearchResults(
                        mergeMultiQueryResults(executed.map((one) => one.results), effectiveLimit).results,
                        queryList.join(' '),
                        { positionWeight: 0 }
                    )
                    : (executed[0]?.results ?? []);

                // fetchTop: 为排名前 N (0~3) 的搜索结果并发拉取正文并注入 fullContent 字段（深拷贝产出新对象，防缓存污染）
                let finalResults = mergedResults;
                if (fetchTop && fetchTop > 0) {
                    const topN = Math.min(fetchTop, 3, mergedResults.length);
                    if (topN > 0) {
                        logTool(`Fetching fullContent for top ${topN} search results`);
                        const fetchTargets = mergedResults.slice(0, topN);
                        const fetchSettled = await Promise.allSettled(
                            fetchTargets.map((item: SearchResult) =>
                                runtime.services.fetchWeb.execute({
                                    url: item.url,
                                    maxChars: 4000,
                                    readability: true,
                                    format: 'markdown',
                                    signal
                                })
                            )
                        );
                        finalResults = mergedResults.map((item: SearchResult, idx: number) => {
                            const cloned = { ...item };
                            if (idx < topN) {
                                const res = fetchSettled[idx];
                                if (res && res.status === 'fulfilled' && res.value.content) {
                                    cloned.fullContent = res.value.content;
                                }
                            }
                            return cloned;
                        });
                    }
                }

                const failures = executed.flatMap((one) => one.partialFailures);
                const allEngines = [...new Set(executed.flatMap((one) => one.engines))];
                const allCascadedEngines = [...new Set(executed.flatMap((one) => one.cascadedEngines ?? []))];
                const allMetrics = mergeEngineMetricsAcrossQueries(executed.map((one) => one.engineMetrics));
                const directAnswer = executed.find((one) => one.directAnswer)?.directAnswer;
                // 多查询（queries）扇出下仅当所有子查询均命中缓存时才标注 cached: true；部分命中时不输出该字段
                const allCached = executed.length > 0 && executed.every((one) => one.cached === true);
                const { outcome, retryable } = computeSearchOutcome(finalResults.length, failures, directAnswer, {
                    requestedLimit: effectiveLimit,
                    minResults: effectiveMinResults,
                    primaryEngines: allEngines
                });

                const outputResults = verbose
                    ? finalResults
                    : finalResults.map((item: SearchResult) => {
                        const { engine: _omittedEngine, engineHits: _omittedHits, ...rest } = item;
                        if (!rest.source || !rest.url) {
                            return rest;
                        }
                        try {
                            const urlHost = new URL(rest.url).hostname.replace(/^www\./i, '').toLowerCase();
                            const srcHost = rest.source.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();
                            if (urlHost && srcHost === urlHost) {
                                const { source: _omittedSource, ...cleanItem } = rest;
                                return cleanItem;
                            }
                        } catch {
                            // keep original item if URL cannot be parsed
                        }
                        return rest;
                    });

                const outputFailures = (verbose || outcome === 'failed')
                    ? failures
                    : failures.map((f) => {
                        const briefMessage = f.message.split(' | Hint:')[0]?.split(' (Hint:')[0]?.trim() || f.message;
                        return { ...f, message: briefMessage };
                    });

                const allWarnings = [...new Set([...requestContext.warnings, ...executed.flatMap((one) => one.warnings ?? [])])];
                const filterFallback = executed.find((one) => one.filterFallback)?.filterFallback;
                const diagnostics = executed.find((one) => one.diagnostics)?.diagnostics;

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            ...(queryList.length > 1
                                ? {
                                    queries: queryList,
                                    queryEngines: queryList.map((q: string, index: number) => ({ query: q, engines: executed[index]?.engines ?? [] }))
                                }
                                : { query: queryList[0] ?? '' }),
                            outcome,
                            ...(outcome !== 'ok' || verbose ? { retryable } : {}),
                            ...(allCached ? { cached: true } : {}),
                            engines: allEngines,
                            ...(allCascadedEngines.length > 0 ? { cascadedEngines: allCascadedEngines } : {}),
                            totalResults: mergedResults.length,
                            results: outputResults,
                            ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
                            ...(filterFallback ? { filterFallback } : {}),
                            ...(diagnostics ? { diagnostics } : {}),
                            ...(outputFailures.length > 0 ? { partialFailures: outputFailures } : {}),
                            ...(directAnswer ? { directAnswer } : {}),
                            ...(verbose && allMetrics.length > 0 ? { engineMetrics: allMetrics } : {})
                        })
                    }],
                    ...(outcome === 'failed' ? { isError: true } : {})
                };
            } catch (error) {
                logSafeError('Search tool execution failed', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            '可尝试换用其他引擎（engines 参数）、降低 limit，或稍后重试。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );

    const unsubscribe = setContext7QuotaListener(() => {
        try {
            searchTool.update({
                description: getSearchDescription()
            });
        } catch {
            // best-effort update
        }
    });

    if (server.server) {
        const prevOnClose = (server.server as { onclose?: () => void }).onclose;
        (server.server as { onclose?: () => void }).onclose = () => {
            unsubscribe?.();
            if (typeof prevOnClose === 'function') {
                prevOnClose();
            }
        };
    }
}
