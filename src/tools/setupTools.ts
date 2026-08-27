// tools/setupTools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    normalizeEngineName,
    resolveRequestedEngines,
    SUPPORTED_SEARCH_ENGINES,
    SupportedSearchEngine
} from '../core/search/searchEngines.js';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../core/validation/targetValidation.js';
import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';
import { FetchWebContentResult } from '../engines/web/fetchWebContent.js';
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

/**
 * fetchWebContent 错误提示按错误类型区分，避免把"页面不存在（404）"也提示成
 * "降低 maxChars 继续分页读取"这类无关建议。依据错误消息/状态码归类：
 * 404 → URL 问题；4xx → 被拒/反爬；5xx → 上游故障；网络类 → 网络/代理；提取失败 → raw/maxChars。
 */
function buildFetchWebErrorHint(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const statusMatch = message.match(/status code (\d{3})/i);
    const status = statusMatch ? Number(statusMatch[1]) : (error as any)?.response?.status;

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

    if (/timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|ENETUNREACH/i.test(message)) {
        return '网络错误——可稍后重试；若目标站点需代理访问，开启 USE_PROXY=true + PROXY_URL 后重试。';
    }

    if (/no readable content|extract/i.test(message)) {
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
        const searchModeDescription = ' searchMode: omit/auto = server SEARCH_MODE; request/playwright force that mode.';
        if (runtime.config.allowedSearchEngines.length === 0) {
            return `Search the web across multiple engines with no API key required.${searchModeDescription}${DOCS_GUIDANCE}`;
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
            return `Search the web using these engines: ${enginesText} (no API key required).${searchModeDescription}${DOCS_GUIDANCE}`;
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
            query: z.string().min(1, "Search query must not be empty").max(500, "Search query too long (max 500 characters)"),
            limit: z.number().min(1).max(50).default(10),
            searchMode: z.enum(['request', 'auto', 'playwright']).optional(),
            minResults: z.number().int().min(0).optional()
                .describe("Auto-run additional engines when fewer than this many results come back (default: disabled)"),
            engines: z.array(getEngineInputSchema()).min(1).default([runtime.config.defaultSearchEngine])
                .transform(requestedEngines => resolveRequestedEngines(
                    requestedEngines,
                    runtime.config.allowedSearchEngines,
                    runtime.config.defaultSearchEngine
                ) as [SupportedSearchEngine, ...SupportedSearchEngine[]])
        },
        {
            // 全部工具均为只读、幂等、开放世界操作（搜索/抓取不修改任何持久状态）
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        },
        async ({query, limit = 10, searchMode, engines, minResults}) => {
            try {
                // 正常走 MCP 时 engines 已由 schema transform 解析；直接调用 handler 的场景
                // （测试/程序化调用）engines 可能未定义，这里补一个兜底。
                const resolvedEngines = (engines ?? [runtime.config.defaultSearchEngine]) as [SupportedSearchEngine, ...SupportedSearchEngine[]];

                logTool(`Searching for "${query}" using engines: ${resolvedEngines.join(', ')}`);

                const searchResult = await runtime.services.search.execute({
                    query,
                    engines: resolvedEngines,
                    limit,
                    searchMode,
                    minResults: minResults ?? 0
                });
                for (const failure of searchResult.partialFailures) {
                    logTool(`Search failed for engine ${failure.engine}: ${failure.message}`);
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            query: searchResult.query,
                            engines: searchResult.engines,
                            totalResults: searchResult.totalResults,
                            results: searchResult.results,
                            partialFailures: searchResult.partialFailures
                        }, null, 2)
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
        "Fetch full article content from a csdn post URL",
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
        "Fetch README content from a GitHub repository URL",
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
        },
        {
            // 全部工具均为只读、幂等、开放世界操作（搜索/抓取不修改任何持久状态）
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        },
        async ({url, maxChars = 30000, readability, includeLinks, raw, startIndex}) => {
            try {
                logTool(`Fetching web content: ${url}`);
                const result = await runtime.services.fetchWeb.execute({ url, maxChars, readability, includeLinks, raw, startIndex });

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
        "Fetch full article content from a Juejin(掘金) post URL",
        {
            url: z.string().url().refine(
                (url) => validateArticleUrl(url, 'juejin'),
                "URL must be from juejin.cn and contain /post/ path"
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
                logTool(`Fetching Juejin article: ${url}`);
                const result = await runtime.services.fetchJuejinArticle.execute({ url });

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
                            '可检查网络连通性（context7.com），或稍后重试。'
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
                            '可先用 resolveLibraryId 确认 libraryId 正确，或稍后重试。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
};

