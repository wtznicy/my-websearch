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

import { detectUnknownParameters } from '../../utils/toolValidation.js';

export function registerFetchGithubTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchGithubToolName = getToolName('MCP_TOOL_FETCH_GITHUB_NAME', 'fetchGithubReadme');

    server.registerTool(
        fetchGithubToolName,
        {
            description: "Fetch GitHub/Gitee content: repository README, source files (/blob/), file trees (/tree/), Issues with solutions (/issues/), and Pull Requests (/pull/). For generic web pages, use fetchWebContent.",
            inputSchema: z.object({
                url: z.string().min(1).max(2048).refine(
                    (url) => validateGithubRepositoryUrl(url),
                    "URL must be a valid GitHub or Gitee repository, file, directory tree, issue, or pull request URL (supports HTTPS, SSH formats)"
                )
            }).passthrough(),
            annotations: TOOL_ANNOTATION_HINTS
        },
        async (rawArgs) => {
            const { url } = rawArgs as { url: string } & Record<string, unknown>;
            const unknownWarnings = detectUnknownParameters(rawArgs as Record<string, unknown>, ['url']);
            try {
                logTool(`Fetching GitHub content: ${url}`);
                const result = await runtime.services.fetchGithubReadme.execute({ url });

                if (result) {
                    return {
                        content: [{
                            type: 'text',
                            text: capTextResponse(result)
                        }],
                        warnings: unknownWarnings
                    } as unknown as { content: Array<{ type: 'text'; text: string }> };
                } else {
                    return {
                        content: [{
                            type: 'text',
                            text: 'Content not found or target repository/item does not exist'
                        }],
                        isError: true
                    };
                }
            } catch (error) {
                logSafeError('Failed to fetch GitHub content', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch GitHub content: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            '若资源存在但抓取失败，可确认 URL 拼写，或配置 GITHUB_TOKEN 以提升 API 速率限制。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
}
