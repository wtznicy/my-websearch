// tools/setupTools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeEngineName } from '../core/search/searchEngines.js';
import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';

import { registerSearchTool } from './handlers/searchTool.js';
import { registerFetchCsdnTool } from './handlers/fetchCsdnTool.js';
import { registerFetchGithubTool } from './handlers/fetchGithubTool.js';
import { registerFetchWebTool } from './handlers/fetchWebTool.js';
import { registerFetchJuejinTool } from './handlers/fetchJuejinTool.js';
import { registerResolveLibraryTool } from './handlers/resolveLibraryTool.js';
import { registerQueryDocsTool } from './handlers/queryDocsTool.js';

export { normalizeEngineName };

/**
 * 注册所有 MCP 工具（拆分为 7 个单一职责处理器）。
 */
export const setupTools = (server: McpServer, runtime: MyWebSearchRuntime): void => {
    registerSearchTool(server, runtime);
    registerFetchCsdnTool(server, runtime);
    registerFetchGithubTool(server, runtime);
    registerFetchWebTool(server, runtime);
    registerFetchJuejinTool(server, runtime);
    registerResolveLibraryTool(server, runtime);
    registerQueryDocsTool(server, runtime);
};
