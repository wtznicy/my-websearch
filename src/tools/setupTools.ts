// tools/setupTools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeEngineName } from '../core/search/searchEngines.js';
import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';

import { registerSearchTool } from './handlers/searchTool.js';
import { registerFetchWebTool } from './handlers/fetchWebTool.js';
import { registerFetchGithubTool } from './handlers/fetchGithubTool.js';
import { registerQueryDocsTool } from './handlers/queryDocsTool.js';
import { registerCodeSymbolTool } from './handlers/codeSymbolTool.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';

export { normalizeEngineName };

/**
 * 注册所有 MCP 工具（拆分为单一职责处理器）。
 *
 * 工具面固定为 5 个：search / fetchWebContent / fetchGithubContent / queryDocs / codeSymbol。
 * CSDN / 掘金 已由 fetchWebContent 按域名自动分流，resolveLibraryId 已并入 queryDocs。
 */
export const setupTools = (server: McpServer, runtime: MyWebSearchRuntime): void => {
    registerSearchTool(server, runtime);
    registerFetchWebTool(server, runtime);
    registerFetchGithubTool(server, runtime);
    registerQueryDocsTool(server, runtime);
    registerCodeSymbolTool(server, runtime);
    registerPrompts(server);
    registerResources(server);
};
