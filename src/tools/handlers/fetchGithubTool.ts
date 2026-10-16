import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateGithubRepositoryUrl } from '../../core/validation/targetValidation.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import {
    getToolName,
    logTool,
    logSafeError,
    withErrorHint,
    capTextResponse,
    TOOL_ANNOTATION_HINTS
} from '../toolShared.js';

export function registerFetchGithubTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchGithubToolName = getToolName('MCP_TOOL_FETCH_GITHUB_NAME', 'fetchGithubReadme');

    server.registerTool(
        fetchGithubToolName,
        {
            description: "Fetch README, source code file (e.g. /blob/main/src/index.ts), or issue discussion (e.g. /issues/123) from a GitHub or Gitee repository URL (github.com or gitee.com URLs only; for other web pages use fetchWebContent)",
            inputSchema: {
                url: z.string().min(1).max(2048).refine(
                    (url) => validateGithubRepositoryUrl(url),
                    "URL must be a valid GitHub or Gitee repository, file, or issue URL (supports HTTPS, SSH formats)"
                )
            },
            annotations: TOOL_ANNOTATION_HINTS
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
}
