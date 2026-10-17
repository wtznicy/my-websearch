// tools/setupTools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeEngineName } from '../core/search/searchEngines.js';
import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';

import { registerSearchTool } from './handlers/searchTool.js';
import { registerFetchWebTool } from './handlers/fetchWebTool.js';
import { registerFetchGithubTool } from './handlers/fetchGithubTool.js';
import { registerQueryDocsTool } from './handlers/queryDocsTool.js';
import { registerFetchCsdnTool } from './handlers/fetchCsdnTool.js';
import { registerFetchJuejinTool } from './handlers/fetchJuejinTool.js';

export { normalizeEngineName };

/**
 * 注册所有 MCP 工具（拆分为单一职责处理器）。
 *
 * 注：fetchCsdnArticle 与 fetchJuejinArticle 已彻底收口并下沉至 fetchWebContent 内部
 * 依域名策略模式自动分流，默认不再向顶层 MCP 工具列表暴露多余的专有工具以节省 Token 并符合 LLM 动作心智。
 * 若历史系统/测试需强行暴露，可设置 REGISTER_LEGACY_ARTICLE_TOOLS=true。
 */
export const setupTools = (server: McpServer, runtime: MyWebSearchRuntime): void => {
    registerSearchTool(server, runtime);
    registerFetchWebTool(server, runtime);
    registerFetchGithubTool(server, runtime);
    registerQueryDocsTool(server, runtime);

    if (process.env.REGISTER_LEGACY_ARTICLE_TOOLS === 'true') {
        registerFetchCsdnTool(server, runtime);
        registerFetchJuejinTool(server, runtime);
    }
};
