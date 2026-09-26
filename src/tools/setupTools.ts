// tools/setupTools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    normalizeEngineName,
    resolveRequestedEngines,
    SUPPORTED_SEARCH_ENGINES,
    SupportedSearchEngine
} from '../core/search/searchEngines.js';
import { pickDefaultEnginesForQuery } from '../core/search/queryEngineRouting.js';
import { isKnownUnreachableOverseasEngine } from '../utils/overseasProbe.js';
import { mergeMultiQueryResults, mergeEngineMetricsAcrossQueries } from '../core/search/multiQuery.js';
import { rankSearchResults } from '../core/search/resultRanking.js';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../core/validation/targetValidation.js';
import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';
import { FetchWebContentResult } from '../engines/web/fetchWebContent.js';
import { isContext7QuotaExhaustedError } from '../engines/context7/context7.js';
import { SearchResult } from '../types.js';
export { normalizeEngineName };

/**
 * MCP 单次响应硬上限（字节）。防止 fetchWebContent 在 raw/大 maxChars 场景下
 * 把数 MB JSON 塞进 MCP response 浪费客户端 token。默认 60KB，可配置。
 */
const rawResponseCap = Number(process.env.OPEN_WEBSEARCH_RESPONSE_CAP_BYTES ?? 60000);
const RESPONSE_CAP_BYTES = Number.isFinite(rawResponseCap) && rawResponseCap > 0 ? rawResponseCap : 60000;

/** 给 MCP 错误文本追加一行 Hint，帮助 LLM/用户决定下一步 */
function withErrorHint(message: string, hint: string): string {
    return `${message}\nHint: ${hint}`;
}

// context7 匿名配额（200 次/月，按出口 IP 计）用尽后，重试不会自愈——
// 用专门 Hint 替代"稍后重试"，避免 LLM 反复重试。
const CONTEXT7_QUOTA_HINT =
    'Context7 匿名配额已用尽（200 次/月，按出口 IP 计，TUN 下即代理节点 IP）；'
    + '设置 CONTEXT7_API_KEY 可立即恢复（免费申请 https://context7.com/dashboard），否则需等配额重置。';

/**
 * 从错误中提取 HTTP 状态码：优先结构化字段（AxiosError.response.status），
 * 正则（axios 的 "Request failed with status code 404" 措辞）仅做兜底——
 * 不依赖 axios 错误文案，避免其大版本改措辞后静默落入兜底分支。
 */
function extractErrorStatus(error: unknown): number | undefined {
    const structured = (error as any)?.response?.status;
    if (typeof structured === 'number') {
        return structured;
    }
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/status code (\d{3})/i);
    if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}

/**
 * fetchWebContent 错误提示按错误类型区分，避免把"页面不存在（404）"也提示成
 * "降低 maxChars 继续分页读取"这类无关建议。依据错误消息/状态码归类：
 * 404 → URL 问题；4xx → 被拒/反爬；5xx → 上游故障；网络类 → 网络/代理；提取失败 → raw/maxChars。
 */
function buildFetchWebErrorHint(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const status = extractErrorStatus(error);

    // 安全拦截放在最前：私网拦截的文案里含 "network" 一词，若先走网络分支会把
    // "已被安全策略拒绝"提示成"开启代理重试"——等于引导调用方绕过防护（测评报告 P1-6）
    if (/private or local network|wildcard DNS|rebinding|blackhole|0\.0\.0\.0\/8/i.test(message)) {
        return '该地址指向内网/本地，或使用了可指向内网的不可信域名，已被安全策略拒绝——这是预期行为，请改用公开可访问的 URL。';
    }

    if (typeof status === 'number') {
        if (status === 404) {
            return '目标页面不存在（404）——检查 URL 是否正确、页面是否已删除、或站点需要登录后才能访问。';
        }
        if (status >= 500) {
            return `目标站点返回服务器错误（HTTP ${status}）——上游问题，可稍后重试或换一个来源页面。`;
        }
        if (status >= 400) {
            return `目标站点拒绝了请求（HTTP ${status}）——页面可能要求登录/验证，或站点对自动化抓取有反爬限制。`;
        }
    }

    if (/could not be resolved|ENOTFOUND|EAI_AGAIN/i.test(message)) {
        return '域名解析失败——检查域名拼写；若本机 DNS 解析不了该站点，可配置代理（USE_PROXY=true + PROXY_URL）后重试。';
    }

    if (/timeout|timed out|ECONN|ETIMEDOUT|socket hang up|network|ENETUNREACH/i.test(message)) {
        return '网络错误——可稍后重试；若目标站点需代理访问，开启 USE_PROXY=true + PROXY_URL 后重试。';
    }

    if (/no readable content|extraction failed/i.test(message)) {
        return '页面正文提取失败——可尝试 raw=true 获取原始内容，或降低 maxChars。';
    }

    return '可降低 maxChars，或用 startIndex 分页继续读取长文档。';
}

/**
 * 工具级日志门控：LOG_LEVEL=quiet（或 OPEN_WEBSEARCH_QUIET_STARTUP=true）时
 * 静默所有工具执行日志（搜索词、URL、库名等），避免噪音与隐私信息写入宿主日志。
 * 现有 LOG_LEVEL 只控制启动日志，这里扩展为全局级别。
 */
const quietToolLogs = (process.env.LOG_LEVEL ?? '').toLowerCase() === 'quiet'
    || process.env.OPEN_WEBSEARCH_QUIET_STARTUP === 'true';

function logTool(message: string): void {
    if (!quietToolLogs) {
        console.error(message);
    }
}

/**
 * 只输出安全的错误摘要（message + HTTP status + code），
 * 不要把整个 AxiosError 打进日志——其 config.headers 里含
 * CONTEXT7_API_KEY 的 Authorization 头和浏览器 Cookie，会泄露凭据。
 */
function logSafeError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const details: string[] = [];
    const status = (error as any)?.response?.status;
    const code = (error as any)?.code;
    if (status !== undefined) {
        details.push(`HTTP ${status}`);
    }
    if (code) {
        details.push(code);
    }
    logTool(`${context}: ${message}${details.length > 0 ? ` (${details.join(', ')})` : ''}`);
}

/**
 * 纯文本响应封顶：超出 RESPONSE_CAP_BYTES（字节）时截断并标注，
 * 防止超长文章/README 把数 MB 文本塞进 MCP response。
 * 按 UTF-8 字节计量（中文 1 字 = 3 字节），并避免切断多字节字符。
 */
function capTextResponse(text: string): string {
    if (Buffer.byteLength(text, 'utf8') <= RESPONSE_CAP_BYTES) {
        return text;
    }
    let truncated = Buffer.from(text, 'utf8').subarray(0, RESPONSE_CAP_BYTES).toString('utf8');
    // 截断点可能落在多字节字符中间，去掉因此产生的替换符（U+FFFD）
    while (truncated.endsWith('\uFFFD')) {
        truncated = truncated.slice(0, -1);
    }
    return `${truncated}\n[truncated by response cap (${RESPONSE_CAP_BYTES} bytes); article too long to return in full]`;
}

/**
 * 序列化 fetchWebContent 结果，超出硬上限时分两级收敛：
 * 1) 丢弃低价值中间字段（readableHtml / raw）；
 * 2) 截断 content 并保留分页指针（startIndex/nextStartIndex/hasMore），
 *    调用方可用 startIndex 继续读完整个文档。
 */
function serializeFetchWebResult(result: FetchWebContentResult): string {
    const full = JSON.stringify(result, null, 2);
    if (full.length <= RESPONSE_CAP_BYTES) {
        return full;
    }

    const { readableHtml, raw, ...core } = result as unknown as Record<string, unknown> & { content?: string; startIndex?: number; totalLength?: number };
    const trimmed = JSON.stringify(core, null, 2);
    if (trimmed.length <= RESPONSE_CAP_BYTES) {
        return trimmed;
    }

    const content = core.content ?? '';
    const overhead = trimmed.length - content.length;
    const room = Math.max(0, RESPONSE_CAP_BYTES - overhead - 256);
    const cut = Math.min(content.length, room);
    const startIndex = core.startIndex ?? 0;
    return JSON.stringify({
        ...core,
        content: `${content.slice(0, cut)}\n[truncated by response cap; use startIndex=${startIndex + cut} to continue]`,
        truncated: true,
        hasMore: true,
        nextStartIndex: startIndex + cut,
        totalLength: core.totalLength ?? content.length
    }, null, 2);
}

// 获取工具名称，优先使用环境变量，否则使用默认值
function getToolName(envVarName: string, defaultName: string): string {
    const configuredName = process.env[envVarName];
    if (configuredName) {
        // Validate tool name to ensure it follows MCP naming conventions
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(configuredName)) {
            console.warn(`Invalid tool name "${configuredName}" from environment variable ${envVarName}. Using default: "${defaultName}"`);
            return defaultName;
        }
        logTool(`Using custom tool name "${configuredName}" for ${envVarName}`);
        return configuredName;
    }
    return defaultName;
}

export const setupTools = (server: McpServer, runtime: MyWebSearchRuntime): void => {
    // Get configurable tool names from environment variables
    const searchToolName = getToolName('MCP_TOOL_SEARCH_NAME', 'search');
    const fetchCsdnToolName = getToolName('MCP_TOOL_FETCH_CSDN_NAME', 'fetchCsdnArticle');
    const fetchGithubToolName = getToolName('MCP_TOOL_FETCH_GITHUB_NAME', 'fetchGithubReadme');
    const fetchJuejinToolName = getToolName('MCP_TOOL_FETCH_JUEJIN_NAME', 'fetchJuejinArticle');
    const fetchWebToolName = getToolName('MCP_TOOL_FETCH_WEB_NAME', 'fetchWebContent');

    // 搜索工具
    // 生成搜索工具的动态描述（精简版；engines 合法值在参数描述里，LLM 可见）
    // 附带的引导语帮助 LLM 选对工具：官方文档优先 Context7（可靠、免代理），
    // 站点定向查询用 site: 操作符（否则通用搜索容易召回无关首页/教程）
    const DOCS_GUIDANCE = ' For OFFICIAL library/framework documentation, prefer resolveLibraryId + queryDocs (more reliable, works without proxy). Use the site: operator for site-specific queries (e.g. "update site:docs.elastic.co").';
    const getSearchDescription = () => {
        // 路由建议写进描述：模型看不到服务端路由代码，只能靠这句决定 engines
        const routingGuidance = ' Engine guidance: for Chinese queries prefer engines=["baidu","sogou","csdn","juejin"] (domestic engines have far better Chinese content coverage); for English/official docs use bing; overseas engines (duckduckgo/brave/startpage/exa) need a proxy. Omit engines to use server-side auto routing. Cite the relevant result URLs as markdown links in your answer.';
        const searchModeDescription = ' searchMode: omit/auto = server SEARCH_MODE; request/playwright force that mode.';
        if (runtime.config.allowedSearchEngines.length === 0) {
            return `Search the web across multiple engines with no API key required.${searchModeDescription}${routingGuidance}${DOCS_GUIDANCE}`;
        } else {
            const enginesText = runtime.config.allowedSearchEngines.map(e => {
                switch (e) {
                    case 'juejin':
                        return 'Juejin(掘金)';
                    case 'startpage':
                        return 'Startpage';
                    case 'sogou':
                        return 'Sogou(搜狗)';
                    default:
                        return e.charAt(0).toUpperCase() + e.slice(1);
                }
            }).join(', ');
            return `Search the web using these engines: ${enginesText} (no API key required).${searchModeDescription}${routingGuidance}${DOCS_GUIDANCE}`;
        }
    };

    // 生成搜索引擎选项的枚举
    const getEnginesEnum = () => {
        // 如果没有限制，使用所有支持的引擎
        const allowedEngines = runtime.config.allowedSearchEngines.length > 0
            ? runtime.config.allowedSearchEngines
            : [...SUPPORTED_SEARCH_ENGINES];

        return z.enum(allowedEngines as [string, ...string[]]);
    };

    const getEngineInputSchema = () => {
        const enginesEnum = getEnginesEnum();
        return z.string()
            .min(1, "Engine value must not be empty")
            // 把合法引擎列表写进 description，客户端/LLM 才能看到可选项
            .describe(`Search engine name. Valid values (normalize alias to canonical name): ${[...SUPPORTED_SEARCH_ENGINES].join(', ')}`)
            .transform((engine) => normalizeEngineName(engine))
            .pipe(enginesEnum);
    };

    server.tool(
        searchToolName,
        getSearchDescription(),
        {
            query: z.string().min(1, "Search query must not be empty").max(500, "Search query too long (max 500 characters)").optional()
                .describe("Single search query (use queries for multi-intent fan-out)"),
            queries: z.array(z.string().min(1, "Query must not be empty").max(500)).min(1).max(4).optional()
                .describe("1-4 queries run concurrently and merged (dedup by URL) — for covering multiple intents in one call (e.g. official docs / Chinese community / English)"),
            limit: z.number().min(1).max(50).optional()
                .describe("Max results (default: server DEFAULT_SEARCH_LIMIT, usually 10)"),
            searchMode: z.enum(['request', 'auto', 'playwright']).optional(),
            minResults: z.number().int().min(0).max(50).optional()
                .describe("Auto-run additional engines when fewer than this many USABLE results (relevant, non-entry-page) come back (default: server DEFAULT_MIN_RESULTS, usually 5; max 50 — larger values only burn the search deadline)"),
            engines: z.array(getEngineInputSchema()).min(1).optional()
                .describe("Search engines to use (default: server default, which may auto-route by query language)")
        },
        {
            // 全部工具均为只读、幂等、开放世界操作（搜索/抓取不修改任何持久状态）
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        },
        async ({query, queries, limit, searchMode, engines, minResults}) => {
            try {
                // 查询列表：queries（1-4，多意图扇出）优先，否则单 query
                const queryList = (queries && queries.length > 0 ? queries : (query ? [query] : [])).map((q) => q.trim()).filter(Boolean);
                if (queryList.length === 0) {
                    return {
                        content: [{ type: 'text', text: 'Provide either "query" or "queries" (1-4 queries).' }],
                        isError: true
                    };
                }
                const primaryQuery = queryList[0];

                // 部署策略来自服务端配置（DEFAULT_SEARCH_LIMIT / DEFAULT_MIN_RESULTS），
                // 工具参数仅作覆盖——模型漏传时不再掉进"1 条结果无级联"的弱路径
                const effectiveLimit = limit ?? runtime.config.defaultSearchLimit;
                const effectiveMinResults = minResults ?? Math.min(effectiveLimit, runtime.config.defaultMinResults);

                // engines 未指定时按查询特征路由（DEFAULT_SEARCH_ENGINE=auto：中文 → baidu，
                // 英文/技术 → bing，见 queryEngineRouting.ts）。
                // 多查询扇出时**逐 query 路由**——混合语言/多意图的 queries 不再整批退化成
                // 首个 query 的引擎（此前 queries=[英,中,英] 会全部走 bing 并召回垃圾）。
                const allowed = runtime.config.allowedSearchEngines;
                // auto 模式返回**一组**引擎（英文默认 bing+duckduckgo 并列，中文默认 baidu）
                const resolveEnginesForQuery = (queryText: string): SupportedSearchEngine[] => {
                    const picked = pickDefaultEnginesForQuery(queryText, runtime.config.defaultSearchEngine, {
                        en: runtime.config.autoRouteEnEngines,
                        zh: runtime.config.autoRouteZhEngines
                    });
                    // 已知不可达的境外引擎（探测失败缓存 1 分钟内、且未走代理）从 auto 默认路由里排除，
                    // 否则每次查询都要白等它 3s×2 探测（实测英文路由 20.7s）。显式指定 engines 的调用不受影响。
                    const reachable = picked.filter((engine) => !isKnownUnreachableOverseasEngine(engine));
                    const routable = reachable.length > 0 ? reachable : picked;
                    const filtered = allowed.length > 0 ? routable.filter((engine) => allowed.includes(engine)) : routable;
                    if (filtered.length > 0) {
                        return filtered as SupportedSearchEngine[];
                    }
                    return (allowed.length > 0 ? [allowed[0]] : routable) as SupportedSearchEngine[];
                };
                const explicitEngines = engines && engines.length > 0
                    ? resolveRequestedEngines(engines, allowed, resolveEnginesForQuery(primaryQuery)[0]) as [SupportedSearchEngine, ...SupportedSearchEngine[]]
                    : null;
                const enginesPerQuery: SupportedSearchEngine[][] = explicitEngines
                    ? queryList.map(() => [...explicitEngines])
                    : queryList.map((q) => resolveEnginesForQuery(q));
                const resolvedEngines = enginesPerQuery[0];

                logTool(`Searching ${queryList.map((q, index) => `"${q}" [${enginesPerQuery[index].join(',')}]`).join(', ')}`);

                // 多查询扇出：并发执行（每个查询独立走缓存/级联），合并后按 URL 去重
                const perQueryLimit = queryList.length > 1
                    ? Math.max(3, Math.ceil(effectiveLimit / queryList.length) + 2)
                    : effectiveLimit;
                const executed = await Promise.all(queryList.map((q, index) => {
                    return runtime.services.search.execute({
                        query: q,
                        engines: enginesPerQuery[index],
                        limit: perQueryLimit,
                        searchMode,
                        minResults: effectiveMinResults
                    });
                }));

                for (const one of executed) {
                    for (const failure of one.partialFailures) {
                        logTool(`Search failed for engine ${failure.engine}: ${failure.message}`);
                    }
                }

                // 多查询合并后再做一次全局重排（positionWeight=0：配额顺序不代表排名）；
                // 相关性用所有 query 的 token 并集，让跨 query 内容信号（含入口页惩罚）决定顺序
                const mergedResults = queryList.length > 1
                    ? rankSearchResults(
                        mergeMultiQueryResults(executed.map((one) => one.results), effectiveLimit).results,
                        queryList.join(' '),
                        { positionWeight: 0 }
                    )
                    : executed[0].results;

                // text 保持 JSON（可被客户端 JSON.parse——紧凑格式省 token；模型友好的引用引导在工具描述里）
                const failures = executed.flatMap((one) => one.partialFailures);
                // 顶层 engines 用并集（扇出时各 query 可能路由到不同引擎，只报第一个会与结果不符）
                const allEngines = [...new Set(executed.flatMap((one) => one.engines))];
                const allMetrics = mergeEngineMetricsAcrossQueries(executed.map((one) => one.engineMetrics));
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            ...(queryList.length > 1
                                ? {
                                    queries: queryList,
                                    queryEngines: queryList.map((q, index) => ({ query: q, engines: executed[index].engines }))
                                }
                                : { query: queryList[0] }),
                            engines: allEngines,
                            totalResults: mergedResults.length,
                            results: mergedResults,
                            partialFailures: failures,
                            ...(executed.find((one) => one.directAnswer)?.directAnswer
                                ? { directAnswer: executed.find((one) => one.directAnswer)!.directAnswer }
                                : {}),
                            ...(allMetrics.length > 0 ? { engineMetrics: allMetrics } : {})
                        })
                    }]
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

    // 获取 CSDN 文章工具
    server.tool(
        fetchCsdnToolName,
        "Fetch full article content from a CSDN article URL (blog.csdn.net /article/details/ only; for other sites use fetchWebContent)",
        {
            url: z.string().url().refine(
                (url) => validateArticleUrl(url, 'csdn'),
                "URL must be from blog.csdn.net contains /article/details/ path"
            )
        },
        {
            // 全部工具均为只读、幂等、开放世界操作（搜索/抓取不修改任何持久状态）
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        },
        async ({url}) => {
            try {
                logTool(`Fetching CSDN article: ${url}`);
                const result = await runtime.services.fetchCsdnArticle.execute({ url });

                return {
                    content: [{
                        type: 'text',
                        text: capTextResponse(result.content)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to fetch CSDN article', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch article: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            '可稍后重试，或确认 URL 是 blog.csdn.net 下的 /article/details/ 文章链接。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );

    // 获取 GitHub README 工具
    server.tool(
        fetchGithubToolName,
        "Fetch README content from a GitHub/Gitee repository URL (github.com or gitee.com repo URLs only; for other pages use fetchWebContent)",
        {
            url: z.string().min(1).max(2048).refine(
                (url) => validateGithubRepositoryUrl(url),
                "URL must be a valid GitHub repository URL (supports HTTPS, SSH formats)"
            )
        },
        {
            // 全部工具均为只读、幂等、开放世界操作（搜索/抓取不修改任何持久状态）
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        },
        async ({url}) => {
            try {
                logTool(`Fetching GitHub README: ${url}`);
                const result = await runtime.services.fetchGithubReadme.execute({ url });

                if (result) {
                    return {
                        content: [{
                            type: 'text',
                            text: capTextResponse(result)
                        }]
                    };
                } else {
                    return {
                        content: [{
                            type: 'text',
                            text: 'README not found or repository does not exist'
                        }],
                        isError: true
                    };
                }
            } catch (error) {
                logSafeError('Failed to fetch GitHub README', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch README: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            '若仓库存在但抓取失败，可尝试用 fetchWebContent 抓取 raw.githubusercontent.com 镜像或稍后重试。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );

    // 获取通用网页/Markdown 内容工具
    server.tool(
        fetchWebToolName,
        "Fetch content from a public HTTP(S) URL (supports Markdown files and normal web pages)",
        {
            url: z.string().url().refine(
                (url) => validatePublicWebUrl(url),
                "URL must be a public HTTP(S) address (private/local network targets are blocked)"
            ),
            maxChars: z.number().int().min(1000).max(200000).default(30000),
            readability: z.boolean().optional(),
            includeLinks: z.boolean().optional(),
            raw: z.boolean().optional().describe("Return the raw response body (HTML/plain text) without extraction"),
            startIndex: z.number().int().min(0).optional().describe("Character offset to start reading from (for paging through long content)"),
            format: z.enum(['text', 'markdown']).optional().describe("Content format: 'markdown' preserves fenced code blocks (with language) and GFM tables — better for technical docs"),
        },
        {
            // 全部工具均为只读、幂等、开放世界操作（搜索/抓取不修改任何持久状态）
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        },
        async ({url, maxChars = 30000, readability, includeLinks, raw, startIndex, format}) => {
            try {
                logTool(`Fetching web content: ${url}`);
                const result = await runtime.services.fetchWeb.execute({ url, maxChars, readability, includeLinks, raw, startIndex, format });

                return {
                    content: [{
                        type: 'text',
                        text: serializeFetchWebResult(result)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to fetch web content', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch web content: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            buildFetchWebErrorHint(error)
                        )
                    }],
                    isError: true
                };
            }
        }
    );

    // 获取掘金文章工具
    server.tool(
        fetchJuejinToolName,
        "Fetch full article content from a Juejin(掘金) post URL (juejin.cn or article.juejin.cn /post/ only; for other sites use fetchWebContent)",
        {
            url: z.string().url().refine(
                (url) => validateArticleUrl(url, 'juejin'),
                "URL must be from juejin.cn and contain /post/ path"
            ),
            format: z.enum(['text', 'markdown']).optional()
                .describe("Output format (default: text). 'markdown' keeps fenced code blocks (with language) and GFM tables — recommended for technical posts")
        },
        {
            // 全部工具均为只读、幂等、开放世界操作（搜索/抓取不修改任何持久状态）
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        },
        async ({url, format}) => {
            try {
                logTool(`Fetching Juejin article: ${url}`);
                const result = await runtime.services.fetchJuejinArticle.execute({ url, format });

                return {
                    content: [{
                        type: 'text',
                        text: capTextResponse(result.content)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to fetch Juejin article', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch article: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            '可稍后重试，或确认 URL 是 juejin.cn 下的 /post/ 文章链接。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );

    // 查找库文档（context7 融合）——按库名搜索官方文档索引
    server.tool(
        "resolveLibraryId",
        "PREFERRED for official docs: resolve a library/package name to a Context7 library ID (e.g. /vercel/next.js). Use this (then queryDocs) FIRST when the task needs official library/framework documentation — more reliable than web search and works without a proxy.",
        {
            libraryName: z.string().min(1).describe("The library or package name to search for (e.g. 'Next.js', 'express', 'prisma')"),
            query: z.string().min(1).optional().describe("The user's question or task, used to rank results by relevance (optional; defaults to the library name when omitted, e.g. 'how to implement authentication')"),
            limit: z.number().int().min(1).max(10).optional().describe("Maximum number of library matches to return (default 5)")
        },
        {
            // 全部工具均为只读、幂等、开放世界操作（搜索/抓取不修改任何持久状态）
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        },
        async ({libraryName, query, limit}) => {
            try {
                logTool(`Context7 resolving library: ${libraryName}`);
                const result = await runtime.services.context7Libraries.execute({ libraryName, query, limit });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to resolve library via Context7', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to resolve library: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            isContext7QuotaExhaustedError(error)
                                ? CONTEXT7_QUOTA_HINT
                                : '可检查网络连通性（context7.com），或稍后重试。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );

    // 获取库文档（context7 融合）——按库 ID 获取官方文档片段与代码示例
    server.tool(
        "queryDocs",
        "Get up-to-date, version-specific official docs and code snippets for a Context7 library ID (e.g. /vercel/next.js, version-pinnable like /vercel/next.js@v15.1.8). Use with resolveLibraryId for official documentation lookups — direct, reliable, no proxy needed.",
        {
            libraryId: z.string().min(1).refine(
                (v) => v.startsWith('/'),
                "libraryId must start with '/' (e.g. /vercel/next.js)"
            ).describe("Exact Context7-compatible library ID (e.g. /vercel/next.js, /packages/express; optional version like /vercel/next.js@v15.1.8)"),
            query: z.string().min(1).optional().describe("The question or task to get relevant documentation for (optional; defaults to an overview when omitted, e.g. 'how to set up middleware with auth')"),
            limit: z.number().int().min(1).max(10).optional().describe("Maximum number of code snippets to return (default 5)")
        },
        {
            // 全部工具均为只读、幂等、开放世界操作（搜索/抓取不修改任何持久状态）
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        },
        async ({libraryId, query, limit}) => {
            try {
                logTool(`Context7 fetching docs for: ${libraryId}`);
                const result = await runtime.services.context7Docs.execute({ libraryId, query, limit });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to fetch docs via Context7', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch docs: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            isContext7QuotaExhaustedError(error)
                                ? CONTEXT7_QUOTA_HINT
                                : '可先用 resolveLibraryId 确认 libraryId 正确，或稍后重试。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
};

