#!/usr/bin/env node
// 必须先于其他 import：在静态依赖链（playwrightClient → config）求值前决定是否静默启动日志
import './utils/startupQuiet.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setupTools } from './tools/setupTools.js';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { randomUUID } from "node:crypto";
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import type { CorsOptions } from 'cors';
import { runCli } from './cli/runCli.js';
import type { MyWebSearchRuntime } from './runtime/runtimeTypes.js';
import { shouldCreateFullRuntimeForInvocation } from './runtime/runtimeSelection.js';
import { shutdownLocalPlaywrightBrowserSessions } from './utils/playwrightClient.js';

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

function createServer(runtime: MyWebSearchRuntime): McpServer {
  const server = new McpServer({
    name: 'web-search',
    version: serverVersion
  });

  setupTools(server, runtime);
  return server;
}

async function main() {
  const argv = process.argv.slice(2);
  // 启动日志静默已由 ./utils/startupQuiet.js（首个 import）按参数决定
  const { config } = await import('./config.js');
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

  // Enable STDIO mode if MODE is 'both' or 'stdio' or not specified
  if (process.env.MODE === undefined || process.env.MODE === 'both' || process.env.MODE === 'stdio') {
    console.error('🔌 Starting STDIO transport...');
    const server = createServer(runtime);
    const stdioTransport = new StdioServerTransport();
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
    app.use(express.json());

    // DNS rebinding 保护：用 SDK 的 hostHeaderValidation 中间件（port-agnostic，
    // 通过 URL API 解析 Host 头的 hostname 部分，兼容 127.0.0.1:3211 这种带端口的请求）。
    // 默认仅放行本地回环；如需局域网/公网访问，用 OPEN_WEBSEARCH_ALLOWED_HOSTS 显式放行。
    const allowedHostnames = process.env.OPEN_WEBSEARCH_ALLOWED_HOSTS
      ? process.env.OPEN_WEBSEARCH_ALLOWED_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
      : ['127.0.0.1', 'localhost', '[::1]'];
    app.use(hostHeaderValidation(allowedHostnames));

    const mcpCorsOptions: CorsOptions = {
      origin: config.corsOrigin || '*',
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Mcp-Session-Id'],
      exposedHeaders: ['Mcp-Session-Id'],
    };

    // 是否启用跨域
    if (config.enableCors) {
      // CORS 开启但 origin 保持默认 *：与 localhost-only 的主机校验（见上方 hostHeaderValidation）
      // 的安全意图存在矛盾——任何站点都能通过浏览器发起跨域调用。打警告提示收紧。
      if (!config.corsOrigin || config.corsOrigin === '*') {
        console.warn('CORS is enabled with default origin "*" — any website can call this local MCP server from the browser. Consider setting CORS_ORIGIN to a specific origin.');
      }
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
    // 之前这里是无上限、无 TTL 的裸对象（测评报告 P1-11）。
    // 三个参数可用环境变量覆盖（默认 30 分钟空闲 / 上限 100 / 每 5 分钟巡检），便于测试与调优。
    const SESSION_IDLE_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS || 30 * 60 * 1000);
    const MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS || 100);
    const SESSION_REAPER_INTERVAL_MS = Number(process.env.MCP_SESSION_REAPER_MS || 5 * 60 * 1000);
    const touchSession = (req: any) => {
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

      // 超量时按最后活跃时间从旧到新回收
      const streamableIds = Object.keys(transports.streamable);
      if (streamableIds.length > MAX_SESSIONS) {
        streamableIds
          .sort((a, b) => (transports.streamable[a]?.lastActiveAt ?? 0) - (transports.streamable[b]?.lastActiveAt ?? 0))
          .slice(0, streamableIds.length - MAX_SESSIONS)
          .forEach((id) => closeSession('streamable', id));
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

      if (sessionId && transports.streamable[sessionId]) {
        // Reuse existing transport
        transport = transports.streamable[sessionId].transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        const server = createServer(runtime);
        const session = {} as StreamableSession;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            // Store the transport by session ID
            transports.streamable[sessionId] = session;
          },
        });

        session.server = server;
        session.transport = transport;
        session.closed = false;
        // 创建即计时：否则从未带上 session 头的会话（如只做过 initialize）不会被 reaper 回收
        session.lastActiveAt = Date.now();

        // Clean up transport when closed
        transport.onclose = () => {
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

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    });

    // Reusable handler for GET and DELETE requests
    const handleSessionRequest = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports.streamable[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      const transport = transports.streamable[sessionId];
      await transport.transport.handleRequest(req, res);
    };

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', handleSessionRequest);

    // Handle DELETE requests for session termination
    app.delete('/mcp', handleSessionRequest);

    // Legacy SSE endpoint for older clients
    app.get('/sse', async (req, res) => {
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

      transport.onclose = () => {
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
        await session.transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send('No transport found for sessionId');
      }
    });

    // Read the port number from the environment variable; use the default port 3211 if it is not set.
    // 3211 与 CLI daemon 的默认端口 3210 相邻，避免与常见的前端 dev server（3000）等撞端口。
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3211;

    // 默认只绑定回环地址，避免端口暴露到局域网/公网（配合上面的 DNS rebinding 保护）。
    // 如需局域网/公网访问，设置 OPEN_WEBSEARCH_HOST=0.0.0.0 显式放开。
    const HOST = process.env.OPEN_WEBSEARCH_HOST || '127.0.0.1';

    const httpServer = app.listen(PORT, HOST, () => {
      console.error(`✅ HTTP server running on ${HOST}:${PORT}`)
    });

    // MCP 路径此前完全没有信号处理（测评报告 P1-11）：SIGINT/SIGTERM 时不关会话、不关
    // HTTP server，会话条目与浏览器会话可能残留。这里做最小优雅关闭。
    const shutdown = (signal: string) => {
      console.error(`👋 Received ${signal}: closing MCP sessions and HTTP server...`);
      for (const id of Object.keys(transports.streamable)) {
        closeSession('streamable', id);
      }
      for (const id of Object.keys(transports.sse)) {
        closeSession('sse', id);
      }
      clearInterval(sessionReaper);
      httpServer.close(() => process.exit(0));
      // 长连接可能让 close 回调迟迟不来，留一个兜底强制退出
      const force = setTimeout(() => process.exit(0), 1500);
      if (typeof force.unref === 'function') {
        force.unref();
      }
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } else {
    console.error('ℹ️ HTTP server disabled, running in STDIO mode only')
  }
}

main().catch(console.error);
