import express from 'express';
import http from 'node:http';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { AppConfig } from '../../config.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { createErrorEnvelope, createSuccessEnvelope } from '../../cli/protocol.js';
import { normalizeEngineName, resolveRequestedEngines, SupportedSearchEngine } from '../../core/search/searchEngines.js';
import { pickDefaultEnginesForQuery } from '../../core/search/queryEngineRouting.js';
import { isKnownUnreachableOverseasEngine } from '../../utils/overseasProbe.js';
import { shutdownLocalPlaywrightBrowserSessions } from '../../utils/playwrightClient.js';
import { ErrorCode, extractErrorCode, extractErrorStatus } from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';
import { isContext7QuotaExhaustedError } from '../../engines/context7/context7.js';

export type LocalDaemonOptions = {
    host?: string;
    port?: number;
    version?: string;
};

export type LocalDaemonStatus = {
    daemon: 'running';
    runtime: 'ready';
    activation: 'active';
    version: string;
    capabilities: string[];
    baseUrl: string;
    configSummary: {
        defaultSearchEngine: string;
        allowedSearchEngines: string[];
        searchMode: string;
        useProxy: boolean;
        fetchWebAllowInsecureTls: boolean;
    };
};

export type LocalDaemonHandle = {
    host: string;
    port: number;
    baseUrl: string;
    server: http.Server;
    getStatus: () => LocalDaemonStatus;
    close: () => Promise<void>;
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;

function getCapabilities(): string[] {
    return [
        'search',
        'fetch-web',
        'fetch-csdn',
        'fetch-juejin',
        'fetch-github-readme',
        'resolve-library-id',
        'query-docs',
        'metrics'
    ];
}

function sendError(
    res: express.Response,
    statusCode: number,
    code: string,
    message: string,
    options: {
        retryable?: boolean;
        details?: Record<string, unknown>;
        hint?: string | null;
    } = {}
): void {
    res.status(statusCode).json(createErrorEnvelope(code, message, options));
}

function parseRequestedEngines(runtime: MyWebSearchRuntime, engines: unknown, query: string): SupportedSearchEngine[] {
    // DEFAULT_SEARCH_ENGINE=auto 时按查询特征自动路由（返回引擎组：中文 → baidu+sogou，英文 → bing+duckduckgo）
    const routed = pickDefaultEnginesForQuery(query, runtime.config.defaultSearchEngine, {
        en: runtime.config.autoRouteEnEngines,
        zh: runtime.config.autoRouteZhEngines
    });
    // 已知不可达的境外引擎（探测失败缓存内且未走代理）从默认路由排除，避免每次查询白等探测；
    // 显式指定 engines 的请求不受影响（下面 engines !== undefined 的分支走原逻辑）
    const reachableRouted = routed.filter((engine) => !isKnownUnreachableOverseasEngine(engine));
    const routable = reachableRouted.length > 0 ? reachableRouted : routed;
    const allowed = runtime.config.allowedSearchEngines;
    const filteredDefault = allowed.length > 0 ? routable.filter((engine) => allowed.includes(engine)) : routable;
    const effectiveDefault = filteredDefault.length > 0
        ? filteredDefault
        : (allowed.length > 0 ? [allowed[0]] : routable);
    const fallbackEngine = effectiveDefault[0] || 'bing';

    if (engines === undefined) {
        return effectiveDefault as SupportedSearchEngine[];
    }

    if (!Array.isArray(engines) || engines.some((engine) => typeof engine !== 'string')) {
        throw new Error('engines must be an array of strings');
    }

    if (engines.length === 0) {
        throw new Error('engines must not be empty');
    }

    const normalized = engines
        .map((engine) => normalizeEngineName(engine))
        .filter(Boolean);

    return resolveRequestedEngines(
        normalized,
        runtime.config.allowedSearchEngines,
        fallbackEngine
    ) as SupportedSearchEngine[];
}

function parseLimit(limit: unknown, fallback: number = 10): number {
    if (limit === undefined) {
        return fallback;
    }

    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('limit must be an integer between 1 and 50');
    }

    return limit;
}

function parseSearchMode(searchMode: unknown): AppConfig['searchMode'] | undefined {
    if (searchMode === undefined) {
        return undefined;
    }

    if (searchMode !== 'request' && searchMode !== 'auto' && searchMode !== 'playwright') {
        throw new Error('searchMode must be one of: request, auto, playwright');
    }

    return searchMode;
}

function parseUrl(url: unknown): string {
    if (typeof url !== 'string' || !url.trim()) {
        throw new Error('url must be a non-empty string');
    }

    return url.trim();
}

function parseMaxChars(maxChars: unknown): number {
    if (maxChars === undefined) {
        return 30000;
    }

    if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < 100 || maxChars > 200000) {
        throw new Error('maxChars must be an integer between 100 and 200000');
    }

    return maxChars;
}

function parseContext7Limit(value: unknown, fallback: number = 5): number {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
        throw new Error('limit must be an integer between 1 and 10');
    }
    return value;
}

function parseBooleanFlag(value: unknown, name: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${name} must be a boolean`);
    }
    return value;
}

function parseFormat(value: unknown): 'text' | 'markdown' | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value !== 'text' && value !== 'markdown') {
        throw new Error('format must be one of: text, markdown');
    }
    return value;
}

function parseStartIndex(value: unknown): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error('startIndex must be a non-negative integer');
    }
    return value;
}

function parseMinResults(value: unknown, fallback: number = 0): number {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error('minResults must be a non-negative integer');
    }
    return value;
}

type FetchErrorClassification = {
    statusCode: number;
    code: string;
    message: string;
    retryable: boolean;
};

/**
 * 按错误特征分类抓取失败：区分"客户端参数错误"（400）与"可重试的服务/网络问题"（502/504）。
 * 超时、网络错误、HTTP 5xx、限流（429）都标记 retryable，让 agent 知道可以重试。
 */
function classifyFetchError(error: unknown): FetchErrorClassification {
    const message = error instanceof Error ? error.message : String(error);
    const code = extractErrorCode(error);
    const status = extractErrorStatus(error);

    // SSRF 防护拒绝（私网/本地地址/非法协议）→ 400 客户端错误，不可重试
    if (message === 'Invalid public HTTP(S) URL'
        || (/private|local network|localhost|127\.0\.0\.1|blackhole|DNS blocking/i.test(message) && /reject|block|not allowed|points to|only public/i.test(message))) {
        return { statusCode: 400, code: ErrorCode.INVALID_ARGUMENTS, message, retryable: false };
    }

    // 明确的参数/越界错误 → 400，不可重试
    if (code === 'ERR_START_INDEX_OUT_OF_RANGE') {
        return { statusCode: 400, code: ErrorCode.INVALID_ARGUMENTS, message, retryable: false };
    }
    if (code === 'ERR_RESPONSE_TOO_LARGE' || /too large/i.test(message)) {
        return { statusCode: 413, code: ErrorCode.PAYLOAD_TOO_LARGE, message, retryable: false };
    }

    // HTTP 状态错误：429 限流与 5xx 可重试；4xx 客户端错误不可重试
    if (status !== undefined) {
        if (status === 429 || status >= 500) {
            return { statusCode: 502, code: ErrorCode.UPSTREAM_ERROR, message, retryable: true };
        }
        return { statusCode: 400, code: ErrorCode.HTTP_ERROR, message, retryable: false };
    }

    // 超时 / 网络错误（ECONN*/ETIMEDOUT/ENOTFOUND/Socket hang up 等）→ 可重试
    if (/timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|ENETUNREACH/i.test(message)) {
        return { statusCode: 504, code: ErrorCode.NETWORK_ERROR, message, retryable: true };
    }

    // 其他（如 "No readable content"）→ 客户端不可重试，但归类为提取失败而非校验失败
    return { statusCode: 422, code: ErrorCode.EXTRACTION_FAILED, message, retryable: false };
}

export async function startLocalDaemon(
    runtime: MyWebSearchRuntime,
    options: LocalDaemonOptions = {}
): Promise<LocalDaemonHandle> {
    const host = options.host ?? DEFAULT_HOST;
    const requestedPort = options.port ?? Number(process.env.OPEN_WEBSEARCH_DAEMON_PORT || DEFAULT_PORT);
    const version = options.version ?? 'unknown';

    const app = express();
    app.use(express.json());

    let baseUrl = '';

    const getStatus = (): LocalDaemonStatus => ({
        daemon: 'running',
        runtime: 'ready',
        activation: 'active',
        version,
        capabilities: getCapabilities(),
        baseUrl,
        configSummary: {
            defaultSearchEngine: runtime.config.defaultSearchEngine,
            allowedSearchEngines: runtime.config.allowedSearchEngines,
            searchMode: runtime.config.searchMode,
            useProxy: runtime.config.useProxy,
            fetchWebAllowInsecureTls: runtime.config.fetchWebAllowInsecureTls
        }
    });

    app.get('/health', (_req, res) => {
        res.json(createSuccessEnvelope({
            daemon: 'running'
        }));
    });

    // P0-6：DNS rebinding 防护（与 index.ts MCP HTTP server 口径对齐）
    // 放在 /health 之后，默认仅放行本地回环（127.0.0.1 / localhost / [::1] 及绑定 host），
    // 支持 OPEN_WEBSEARCH_ALLOWED_HOSTS 环境变量扩展白名单。
    const allowedHostnames = process.env.OPEN_WEBSEARCH_ALLOWED_HOSTS
        ? process.env.OPEN_WEBSEARCH_ALLOWED_HOSTS.split(',').map((item) => item.trim()).filter(Boolean)
        : ['127.0.0.1', 'localhost', '[::1]'];
    if (host && !allowedHostnames.includes(host)) {
        allowedHostnames.push(host);
    }
    app.use(hostHeaderValidation(allowedHostnames));

    app.get('/status', (_req, res) => {
        res.json(createSuccessEnvelope(getStatus()));
    });

    // Prometheus 文本格式指标（只读；供本地监控采集，复用 core/metrics 的进程内统计）
    app.get('/metrics', (_req, res) => {
        // 指标收集是 opt-in（METRICS_ENABLED=true）：未启用时计数器恒为 0，直接说明原因，
        // 免得使用者以为是坏掉的仪表盘（测评报告 P2-15 的"指标恒为 0"一半来自这里）
        const notice = process.env.METRICS_ENABLED === 'true'
            ? ''
            : '# note: METRICS_ENABLED is not set to "true" — engine/cache counters stay at 0 by design\n';
        res.type('text/plain; version=0.0.4; charset=utf-8').send(notice + metrics.renderPrometheus());
    });

    app.post('/cache/clear', async (req, res) => {
        const remoteIp = req.socket.remoteAddress;
        const isLoopback = !remoteIp || remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
        if (!isLoopback) {
            sendError(res, 403, 'forbidden', 'Cache clearing is only permitted from loopback clients.');
            return;
        }
        try {
            runtime.services.search.clearCache();
            res.json(createSuccessEnvelope({
                cleared: true,
                cacheSize: runtime.services.search.cacheSize
            }));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendError(res, 500, 'engine_error', message, {
                hint: 'Restart the daemon if the cache cannot be cleared.'
            });
        }
    });

    app.post('/search', async (req, res) => {
        try {
            const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
            if (!query) {
                sendError(
                    res,
                    400,
                    'invalid_request',
                    'query must be a non-empty string',
                    { hint: 'Provide a search query and optionally limit and engines.' }
                );
                return;
            }

            const limit = parseLimit(req.body?.limit, runtime.config.defaultSearchLimit);
            const engines = parseRequestedEngines(runtime, req.body?.engines, query);
            const searchMode = parseSearchMode(req.body?.searchMode);
            const minResults = parseMinResults(req.body?.minResults, Math.min(limit, runtime.config.defaultMinResults));
            const result = await runtime.services.search.execute({
                query,
                limit,
                engines,
                searchMode,
                minResults
            });
            if (result.outcome === 'failed') {
                const failureSummary = result.partialFailures
                    .map((failure) => `${failure.engine}: ${failure.message}`)
                    .join('; ') || 'All search engines failed';
                res.status(502).json(createErrorEnvelope(
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
                        hint: 'Retry with a different engine (`--engine` / `engines`), inspect proxy/network status with `my-websearch doctor`, or try again later.'
                    }
                ));
                return;
            }
            res.json(createSuccessEnvelope(result));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const statusCode = message.includes('must') || message.includes('empty') ? 400 : 500;
            sendError(
                res,
                statusCode,
                statusCode === 400 ? 'invalid_request' : 'engine_error',
                message,
                {
                    hint: statusCode === 400
                        ? 'Use a non-empty query, a limit between 1 and 50, valid engine names, and an optional searchMode of request/auto/playwright.'
                        : 'Retry with a different engine or inspect daemon/runtime configuration.'
                }
            );
        }
    });

    app.post('/fetch-web', async (req, res) => {
        try {
            const url = parseUrl(req.body?.url);
            const maxChars = parseMaxChars(req.body?.maxChars);
            const readability = parseBooleanFlag(req.body?.readability, 'readability');
            const includeLinks = parseBooleanFlag(req.body?.includeLinks, 'includeLinks');
            const raw = parseBooleanFlag(req.body?.raw, 'raw');
            const startIndex = parseStartIndex(req.body?.startIndex);
            const format = parseFormat(req.body?.format);
            const result = await runtime.services.fetchWeb.execute({ url, maxChars, readability, includeLinks, raw, startIndex, format });
            res.json(createSuccessEnvelope(result));
        } catch (error) {
            const classification = classifyFetchError(error);
            sendError(res, classification.statusCode, classification.code, classification.message, {
                retryable: classification.retryable,
                hint: 'Use a public HTTP(S) URL, keep maxChars within the supported range, and pass readability/includeLinks/raw only as booleans and startIndex as a non-negative integer.'
            });
        }
    });

    app.post('/fetch-github-readme', async (req, res) => {
        try {
            const url = parseUrl(req.body?.url);
            const result = await runtime.services.fetchGithubReadme.execute({ url });

            if (!result) {
                sendError(res, 404, ErrorCode.NOT_FOUND, 'README not found or repository does not exist', {
                    hint: 'Verify the repository URL and default branch contents.'
                });
                return;
            }

            res.json(createSuccessEnvelope({
                url,
                content: result
            }));
        } catch (error) {
            const classification = classifyFetchError(error);
            sendError(res, classification.statusCode, classification.code, classification.message, {
                retryable: classification.retryable,
                hint: 'Use a valid GitHub repository URL in HTTPS or SSH form.'
            });
        }
    });

    app.post('/fetch-csdn', async (req, res) => {
        try {
            const url = parseUrl(req.body?.url);
            const result = await runtime.services.fetchCsdnArticle.execute({ url });
            res.json(createSuccessEnvelope({
                url,
                content: result.content
            }));
        } catch (error) {
            const classification = classifyFetchError(error);
            sendError(res, classification.statusCode, classification.code, classification.message, {
                retryable: classification.retryable,
                hint: 'Use a valid blog.csdn.net article URL.'
            });
        }
    });

    app.post('/fetch-juejin', async (req, res) => {
        try {
            const url = parseUrl(req.body?.url);
            const format = parseFormat(req.body?.format);
            const result = await runtime.services.fetchJuejinArticle.execute({ url, format });
            res.json(createSuccessEnvelope({
                url,
                content: result.content
            }));
        } catch (error) {
            const classification = classifyFetchError(error);
            sendError(res, classification.statusCode, classification.code, classification.message, {
                retryable: classification.retryable,
                hint: 'Use a valid juejin.cn post URL.'
            });
        }
    });

    app.post('/resolve-library-id', async (req, res) => {
        try {
            const libraryName = typeof req.body?.libraryName === 'string' ? req.body.libraryName.trim() : '';
            if (!libraryName) {
                sendError(res, 400, ErrorCode.INVALID_ARGUMENTS, 'libraryName must be a non-empty string', {
                    hint: 'Provide a library or package name (e.g. Next.js, express).'
                });
                return;
            }
            const query = typeof req.body?.query === 'string' && req.body.query.trim() ? req.body.query.trim() : undefined;
            const limit = parseContext7Limit(req.body?.limit, 5);
            const result = await runtime.services.context7Libraries.execute({ libraryName, query, limit });
            const payload = result.query
                ? result
                : { libraryName: result.libraryName, results: result.results };
            res.json(createSuccessEnvelope(payload));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const quotaExhausted = isContext7QuotaExhaustedError(error);
            sendError(
                res,
                quotaExhausted ? 429 : 502,
                quotaExhausted ? ErrorCode.RATE_LIMITED : ErrorCode.UPSTREAM_ERROR,
                message,
                {
                    retryable: true,
                    hint: quotaExhausted ? 'Context7 quota exhausted, retry later.' : 'Check connectivity to context7.com or retry later.'
                }
            );
        }
    });

    app.post('/query-docs', async (req, res) => {
        try {
            const libraryId = typeof req.body?.libraryId === 'string' ? req.body.libraryId.trim() : '';
            if (!libraryId || !libraryId.startsWith('/')) {
                sendError(res, 400, ErrorCode.INVALID_ARGUMENTS, "libraryId must be a non-empty string starting with '/' (e.g. /vercel/next.js)", {
                    hint: 'Resolve library ID first using /resolve-library-id.'
                });
                return;
            }
            const query = typeof req.body?.query === 'string' && req.body.query.trim() ? req.body.query.trim() : undefined;
            const limit = parseContext7Limit(req.body?.limit, 5);
            const result = await runtime.services.context7Docs.execute({ libraryId, query, limit });
            res.json(createSuccessEnvelope(result));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const quotaExhausted = isContext7QuotaExhaustedError(error);
            sendError(
                res,
                quotaExhausted ? 429 : 502,
                quotaExhausted ? ErrorCode.RATE_LIMITED : ErrorCode.UPSTREAM_ERROR,
                message,
                {
                    retryable: true,
                    hint: quotaExhausted ? 'Context7 quota exhausted, retry later.' : 'Verify libraryId or retry later.'
                }
            );
        }
    });

    const server = await new Promise<http.Server>((resolve, reject) => {
        const startedServer = app.listen(requestedPort, host, () => resolve(startedServer));
        startedServer.on('error', reject);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve local daemon address');
    }

    baseUrl = `http://${host}:${address.port}`;

    return {
        host,
        port: address.port,
        baseUrl,
        server,
        getStatus,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });

            // 修复本地 daemon 结束后浏览器残留的问题：
            // daemon 原来只关闭 HTTP server，没有显式销毁共享 Playwright 浏览器会话。
            // 这里在服务停止后同步回收当前进程持有的浏览器实例，确保 Edge 根进程一并退出。
            // hidden-headed 模式走 forceKill 分支，保证杀死浏览器进程；
            // 纯 headed 模式由 Playwright 自己 launch，browser.close() 即可结束进程。
            // 这里做 best-effort 清理：即使浏览器回收失败，也不应让 daemon close() 抛异常，
            // 否则调用方（测试/自动化）会收到一个跟 HTTP 服务无关的拒绝，使清理流程变脆弱。
            try {
                await shutdownLocalPlaywrightBrowserSessions();
            } catch (error) {
                console.warn('Local daemon closed, but failed to shut down Playwright browser sessions:', error);
            }
        }
    };
}
