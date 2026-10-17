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
            description: "Fetch comprehensive GitHub/Gitee content: repository README, source code files (/blob/:branch/:path with language-tagged code blocks), directory trees (/tree/:branch/:path with clean ASCII trees), Issue discussions (/issues/:number with top solutions/comments), or Pull Requests (/pull/:number with changed files list). For generic web pages, use fetchWebContent.",
            inputSchema: {
                url: z.string().min(1).max(2048).refine(
                    (url) => validateGithubRepositoryUrl(url),
                    "URL must be a valid GitHub or Gitee repository, file, directory tree, issue, or pull request URL (supports HTTPS, SSH formats)"
                )
            },
            annotations: TOOL_ANNOTATION_HINTS
        },
        async ({url}) => {
            try {
                logTool(`Fetching GitHub content: ${url}`);
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
