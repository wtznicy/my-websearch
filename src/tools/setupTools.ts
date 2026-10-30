// tools/setupTools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeEngineName } from '../core/search/searchEngines.js';
import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';

import { registerSearchTool } from './handlers/searchTool.js';
import { registerFetchWebTool } from './handlers/fetchWebTool.js';
import { registerFetchGithubTool } from './handlers/fetchGithubTool.js';
import { registerQueryDocsTool } from './handlers/queryDocsTool.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';

export { normalizeEngineName };

/**
 * 注册所有 MCP 工具（拆分为单一职责处理器）。
 *
 * 工具面固定为 4 个：CSDN / 掘金 已由 fetchWebContent 按域名自动分流，
 * resolveLibraryId 已并入 queryDocs。历史上曾用 REGISTER_LEGACY_ARTICLE_TOOLS
 * 开关保留那三个专有工具，现已移除——它们长期不执行，却仍占用工具描述预算。
 */
export const setupTools = (server: McpServer, runtime: MyWebSearchRuntime): void => {
    registerSearchTool(server, runtime);
    registerFetchWebTool(server, runtime);
    registerFetchGithubTool(server, runtime);
    registerQueryDocsTool(server, runtime);
    registerPrompts(server);
    registerResources(server);
};
