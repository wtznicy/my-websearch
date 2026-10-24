#!/usr/bin/env node
// 必须先于其他 import：在静态依赖链（playwrightClient → config）求值前决定是否静默启动日志
import './utils/startupQuiet.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { applyHostValidation, applyJsonBody } from './adapters/http/sharedMiddleware.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import type { Request } from 'express';
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { randomUUID } from "node:crypto";
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import { runCli } from './cli/runCli.js';
import type { MyWebSearchRuntime } from './runtime/runtimeTypes.js';
import { shouldCreateFullRuntimeForInvocation } from './runtime/runtimeSelection.js';
import { shutdownLocalPlaywrightBrowserSessions } from './utils/playwrightClient.js';
import {
  buildMcpCorsOptions,
  createSessionCapacityManager,
  type SessionSlotReservation
} from './adapters/http/mcpHttpSecurity.js';
import { configureLogging, installConsoleBridge } from './core/log.js';

// 统一日志：级别来自 LOG_LEVEL；启动静默时默认 warn。console.* 统一转 stderr，
// 避免污染 CLI --json 的 stdout。
configureLogging({ quietStartup: process.env.OPEN_WEBSEARCH_QUIET_STARTUP === 'true' });
installConsoleBridge();

// 从 package.json 注入真实版本号，避免 MCP 客户端看到的 server 版本失真。
// 注意：此文件编译后位于 build/index.js，package.json 在仓库根目录，需上溯一级。
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const serverVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;

type StreamableSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closed: boolean;
  /** 最后活跃时间（毫秒）：客户端异常断开时也能被 reaper 回收 */
  lastActiveAt?: number;
};

type SseSession = {
  server: McpServer;
  transport: SSEServerTransport;
  closed: boolean;
  lastActiveAt?: number;
};

let setupToolsFn: ((server: McpServer, runtime: MyWebSearchRuntime) => void) | undefined;

export const SERVER_INSTRUCTIONS = `
my-websearch provides 4 focused tools for web search, web extraction, Git repositories, and documentation:
1. 'search': Multi-engine web and code search. Use for finding pages, articles, issues, and code snippets across Bing, Baidu, DuckDuckGo, Brave, GitHub, grep.app, etc. Supports multi-query, timeRange (day/week/month/year), and site filters.
2. 'fetchWebContent': Extract readable content and markdown from generic web pages and PDF files. Use for reading articles, blogs, documentation pages, or downloading and parsing PDF documents.
3. 'fetchGithubContent': Fetch GitHub/Gitee content by URL: README, a single source file (/blob/), a directory tree (/tree/), an Issue (/issues/), or a PR (/pull/ on GitHub, /pulls/ on Gitee). Examples: https://github.com/owner/repo/blob/main/src/index.ts ; https://gitee.com/owner/repo/blob/master/README.md ; https://github.com/owner/repo/issues/42 ; https://gitee.com/owner/repo/pulls/4 — ref may be a branch, tag, or commit; one file or directory per call, not a whole-repo clone.
4. 'queryDocs': Direct access to official documentation and code snippets for libraries and frameworks (Context7 with npm/PyPI and GitHub fallback). Always prefer queryDocs over general web search for official library APIs and examples.

Routing guidance:
- Prefer 'queryDocs' for official package documentation (no proxy required).
- Prefer 'fetchGithubContent' for GitHub/Gitee repos, files, issues, and PRs.
- Prefer 'fetchWebContent' for generic URLs and PDF files.
- Use 'search' with site: operator (e.g. site:docs.python.org) or timeRange for targeted queries.
`.trim();

function createServer(runtime: MyWebSearchRuntime): McpServer {
  const server = new McpServer(
    {
      name: 'web-search',
      version: serverVersion
    },
    {
      instructions: SERVER_INSTRUCTIONS
    }
  );

  if (setupToolsFn) {
    setupToolsFn(server, runtime);
  }
  return server;
}

async function main() {
  const argv = process.argv.slice(2);
  // 启动日志静默已由 ./utils/startupQuiet.js（首个 import）按参数决定
  const { config } = await import('./config.js');
  const { setupTools } = await import('./tools/setupTools.js');
  setupToolsFn = setupTools;
  const runtime = shouldCreateFullRuntimeForInvocation(argv)
    ? (await import('./runtime/createRuntime.js')).createMyWebSearchRuntime()
    : ({
        config,
        services: {} as MyWebSearchRuntime['services']
      } satisfies MyWebSearchRuntime);
  const cliExitCode = await runCli(argv, runtime, {
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text)
  });

  if (cliExitCode !== null) {
    // best-effort 清理：shutdown 失败不应覆盖 CLI 本身的退出码
    try {
      await shutdownLocalPlaywrightBrowserSessions();
    } catch (error) {
      console.error('Failed to shut down local Playwright browser sessions:', error);
    }
    process.exitCode = cliExitCode;
    return;
  }

  // MODE 非法值此前是"静默空转"：stdio 分支只认 undefined/both/stdio，HTTP 分支只认 both/http，
  // 于是 MODE=bogus 时两个传输都不启动、无报错、退出码 0（实测：打印一行误导性的
  // "HTTP server disabled, running in STDIO mode only" 后直接退出，任何 JSON-RPC 请求都无响应）。
  // 这里显式校验：非法值直接报错退出，省掉使用者半小时排查。
  const modeValue = process.env.MODE;
  if (modeValue !== undefined && !['both', 'http', 'stdio'].includes(modeValue)) {
    console.error(`❌ Invalid MODE="${modeValue}". Expected one of: both, http, stdio (or leave MODE unset for "both").`);
    process.exit(1);
  }

  let isShuttingDown = false;
  let httpShutdownCleanup: (() => Promise<void>) | undefined;

  const gracefulShutdown = async (signalOrReason: string) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    console.error(`👋 Received ${signalOrReason}: shutting down MCP server and cleaning up browser sessions...`);

    if (httpShutdownCleanup) {
      try {
        await Promise.race([
          httpShutdownCleanup(),
          new Promise((resolve) => setTimeout(resolve, 1500))
        ]);
      } catch {
        // ignore
      }
    }

    try {
      await shutdownLocalPlaywrightBrowserSessions();
    } catch {
      // ignore
    }

    process.exit(0);
  };

  process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
  process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

  // Enable STDIO mode if MODE is 'both' or 'stdio' or not specified
  if (process.env.MODE === undefined || process.env.MODE === 'both' || process.env.MODE === 'stdio') {
    console.error('🔌 Starting STDIO transport...');
    const server = createServer(runtime);
    const stdioTransport = new StdioServerTransport();
    process.stdin.once('close', () => {
      void gracefulShutdown('stdin close');
    });
    await server.connect(stdioTransport).then(() => {
      console.error('✅ STDIO transport enabled');
    }).catch(error => {
      console.error('❌ Failed to initialize STDIO transport:', error);
    });
  }

  // Only set up HTTP server if enabled
  if (config.enableHttpServer) {
    console.error('🔌 Starting HTTP server...');
    // 创建 Express 应用
    const app = express();
    applyJsonBody(app);

    // 容器/平台健康检查探针（Glama / Docker / K8s 等环境探活）：
    // 必须放在 hostHeaderValidation 之前，避免容器外或集群内的探针因 Host 头不是 localhost 被误拦截。
    app.get(['/health', '/ping'], (_req, res) => {
      res.json({
        status: 'healthy',
        version: serverVersion,
        name: 'my-websearch'
      });
    });

    // 绑定地址必须先解析：Host 白名单要和它联动，否则 HOST=0.0.0.0（Docker/容器）
    // 的部署会被 Host 校验 403 掉——文档里的生产配方直接失效。
    const HOST = process.env.OPEN_WEBSEARCH_HOST || process.env.HOST || '127.0.0.1';
    // DNS rebinding 保护（与本地 REST daemon 共用同一套白名单解析，见 adapters/http/sharedMiddleware）
    applyHostValidation(app, [HOST]);

    const mcpCorsOptions = buildMcpCorsOptions(config);
    if (mcpCorsOptions) {
      app.use(cors(mcpCorsOptions));
      // express 5 中裸 * 不再是通配符（path-to-regexp v8 要求命名通配符），
      // CORS preflight 需用 /*splat 匹配所有路径的 OPTIONS 请求
      app.options('/*splat', cors(mcpCorsOptions));
    }

    // Store transports for each session type
    const transports = {
      streamable: {} as Record<string, StreamableSession>,
      sse: {} as Record<string, SseSession>
    };

    // 会话卫生：客户端异常断开（未触发 onclose）时条目会永久滞留，
    // 因此给每个会话记录最后活跃时间，由 reaper 回收空闲会话，并对总量设上限。
    // 三个参数可用环境变量覆盖（默认 30 分钟空闲 / 上限 100 / 每 5 分钟巡检），便于测试与调优。
    const parsePositiveNumber = (val: string | undefined, defaultVal: number, minVal: number, maxVal: number): number => {
      const num = Number(val);
      if (!Number.isFinite(num) || num <= 0) return defaultVal;
      return Math.min(Math.max(num, minVal), maxVal);
    };

    const SESSION_IDLE_TTL_MS = parsePositiveNumber(process.env.MCP_SESSION_TTL_MS, 30 * 60 * 1000, 10_000, 7 * 24 * 3600 * 1000);
    const MAX_SESSIONS = parsePositiveNumber(process.env.MCP_MAX_SESSIONS, 100, 1, 10_000);
    const SESSION_REAPER_INTERVAL_MS = parsePositiveNumber(process.env.MCP_SESSION_REAPER_MS, 5 * 60 * 1000, 5_000, 24 * 3600 * 1000);
    const sessionCapacity = createSessionCapacityManager(
      MAX_SESSIONS,
      () => Object.keys(transports.streamable).length + Object.keys(transports.sse).length
    );
    const touchSession = (req: Request) => {
      const sessionId = req.headers?.['mcp-session-id'] as string | undefined;
      const session = sessionId ? transports.streamable[sessionId] : undefined;
      if (session) {
        session.lastActiveAt = Date.now();
      }
    };
    app.use((req, _res, next) => {
      touchSession(req);
      next();
    });

    const closeSession = (kind: 'streamable' | 'sse', id: string) => {
      const session = (kind === 'streamable' ? transports.streamable : transports.sse)[id];
      if (!session) {
        return;
      }
      try {
        void session.server.close?.();
      } catch (error) {
        console.error(`❌ Failed to close ${kind} session server ${id}:`, error);
      }
      try {
        void session.transport.close?.();
      } catch (error) {
        console.error(`❌ Failed to close ${kind} session ${id}:`, error);
      }
      if (kind === 'streamable') {
        delete transports.streamable[id];
      } else {
        delete transports.sse[id];
      }
    };

    const sessionReaper = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of Object.entries(transports.streamable)) {
        if (now - (session.lastActiveAt ?? now) > SESSION_IDLE_TTL_MS) {
          console.error(`🧹 Closing idle streamable session ${id}`);
          closeSession('streamable', id);
        }
      }
      for (const [id, session] of Object.entries(transports.sse)) {
        if (now - (session.lastActiveAt ?? now) > SESSION_IDLE_TTL_MS) {
          console.error(`🧹 Closing idle SSE session ${id}`);
          closeSession('sse', id);
        }
      }

      // 超量时统一按最后活跃时间从旧到新回收（涵盖 streamable 与 sse 两个入口）
      const allActive: Array<{ kind: 'streamable' | 'sse'; id: string; lastActiveAt: number }> = [
        ...Object.entries(transports.streamable).map(([id, s]) => ({
          kind: 'streamable' as const,
          id,
          lastActiveAt: s.lastActiveAt ?? 0
        })),
        ...Object.entries(transports.sse).map(([id, s]) => ({
          kind: 'sse' as const,
          id,
          lastActiveAt: s.lastActiveAt ?? 0
        }))
      ];
      if (allActive.length > MAX_SESSIONS) {
        allActive
          .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
          .slice(0, allActive.length - MAX_SESSIONS)
          .forEach((entry) => closeSession(entry.kind, entry.id));
      }
    }, SESSION_REAPER_INTERVAL_MS);
    // 不让 reaper 拖住进程退出（否则 CLI 一次性命令会挂住）
    if (typeof sessionReaper.unref === 'function') {
      sessionReaper.unref();
    }

    // Handle POST requests for client-to-server communication
    app.post('/mcp', async (req, res) => {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;
      let reservation: SessionSlotReservation | null = null;

      const existingSession = sessionId ? transports.streamable[sessionId] : undefined;

      if (existingSession) {
        // Reuse existing transport
        transport = existingSession.transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // 统一计数器预占名额（含初始化中 + 已活跃的 streamable 与 sse 会话），超限时立即返回 429
        reservation = sessionCapacity.tryReserve();
        if (!reservation) {
          res.status(429).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: `Too Many Requests: Maximum concurrent MCP sessions (${MAX_SESSIONS}) exceeded`,
            },
            id: null,
          });
          return;
        }

        // New initialization request
        const server = createServer(runtime);
        const session = {} as StreamableSession;
        const slotReservation = reservation;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            // Store the transport by session ID and promote reserved slot to active
            transports.streamable[initializedSessionId] = session;
            slotReservation.promoteToActive();
          },
        });

        session.server = server;
        session.transport = transport;
        session.closed = false;
        // 创建即计时：否则从未带上 session 头的会话（如只做过 initialize）不会被 reaper 回收
        session.lastActiveAt = Date.now();

        // Clean up transport when closed
        transport.onclose = () => {
          slotReservation.release();
          if (transport.sessionId && transports.streamable[transport.sessionId] === session) {
            delete transports.streamable[transport.sessionId];
          }

          if (session.closed) {
            return;
          }

          session.closed = true;
          void server.close().catch(error => {
            console.error('❌ Failed to close streamable MCP server:', error);
          });
        };

        // Connect to the MCP server
        try {
          await server.connect(transport);
        } catch (error) {
          slotReservation.release();
          session.closed = true;
          void server.close().catch(closeError => {
            console.error('❌ Failed to close streamable MCP server after connect error:', closeError);
          });
          throw error;
        }
      } else {
        // Invalid request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request; ensure any unpromoted initializing slot is released on completion/failure
      try {
        await transport.handleRequest(req, res, req.body);
      } finally {
        reservation?.release();
      }
    });

    // Reusable handler for GET and DELETE requests
    const handleSessionRequest = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? transports.streamable[sessionId] : undefined;
      if (!session) {
        // MCP 规范：会话不存在应返回 404，客户端据此重建会话；400 会让客户端卡死在坏会话上
        res.status(404).send('Session not found');
        return;
      }

      await session.transport.handleRequest(req, res);
    };

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', handleSessionRequest);

    // Handle DELETE requests for session termination
    app.delete('/mcp', handleSessionRequest);

    // Legacy SSE endpoint for older clients
    app.get('/sse', async (_req, res) => {
      const reservation = sessionCapacity.tryReserve();
      if (!reservation) {
        res.status(429).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: `Too Many Requests: Maximum concurrent MCP sessions (${MAX_SESSIONS}) exceeded`,
          },
          id: null,
        });
        return;
      }

      // Create SSE transport for legacy clients
      const transport = new SSEServerTransport('/messages', res);
      const server = createServer(runtime);
      const session: SseSession = {
        server,
        transport,
        closed: false,
        lastActiveAt: Date.now()
      };

      transports.sse[transport.sessionId] = session;
      reservation.promoteToActive();

      transport.onclose = () => {
        reservation.release();
        if (transports.sse[transport.sessionId] === session) {
          delete transports.sse[transport.sessionId];
        }

        if (session.closed) {
          return;
        }

        session.closed = true;
        void server.close().catch(error => {
          console.error('❌ Failed to close SSE MCP server:', error);
        });
      };

      try {
        await server.connect(transport);
      } catch (error) {
        reservation.release();
        delete transports.sse[transport.sessionId];
        session.closed = true;
        void server.close().catch(closeError => {
          console.error('❌ Failed to close SSE MCP server after connect error:', closeError);
        });
        throw error;
      }
    });

    // Legacy message endpoint for older clients
    app.post('/messages', async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const session = transports.sse[sessionId];
      if (session) {
        session.lastActiveAt = Date.now();
        await session.transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(404).send('Session not found');
      }
    });

    // Read the port number from the environment variable; use the default port 3211 if it is not set.
    // 3211 与 CLI daemon 的默认端口 3210 相邻，避免与常见的前端 dev server（3000）等撞端口。
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3211;

    // 默认只绑定回环地址，避免端口暴露到局域网/公网（配合上面的 DNS rebinding 保护）。
    // 如需局域网/公网或容器访问，设置 OPEN_WEBSEARCH_HOST=0.0.0.0 或 HOST=0.0.0.0 显式放开。
    // （HOST 已在 Host 白名单注册前解析，见上方 applyHostValidation 调用）

    const httpServer = app.listen(PORT, HOST, () => {
      console.error(`✅ HTTP server running on ${HOST}:${PORT}`);
    });

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        clearInterval(sessionReaper);
        if (process.env.MODE !== 'http') {
          console.error(`⚠️ HTTP port ${PORT} is already in use (${HOST}:${PORT}); HTTP server disabled for this instance, continuing in STDIO mode only.`);
          return;
        }
        console.error(`❌ HTTP port ${PORT} is already in use (${HOST}:${PORT}). Exit.`);
        process.exit(1);
      }
      console.error(`❌ Failed to start HTTP server on ${HOST}:${PORT}:`, err.message);
      process.exit(1);
    });

    httpShutdownCleanup = () => {
      for (const id of Object.keys(transports.streamable)) {
        closeSession('streamable', id);
      }
      for (const id of Object.keys(transports.sse)) {
        closeSession('sse', id);
      }
      clearInterval(sessionReaper);
      return new Promise<void>((resolve) => {
        try {
          httpServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
    };
  } else {
    console.error('ℹ️ HTTP server disabled, running in STDIO mode only')
  }
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exitCode = 1;
});

