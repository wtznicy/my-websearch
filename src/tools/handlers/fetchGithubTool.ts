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
import { isAppError } from '../../core/errors.js';

import { detectUnknownParameters } from '../../utils/toolValidation.js';

export function registerFetchGithubTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchGithubToolName = getToolName('MCP_TOOL_FETCH_GITHUB_NAME', 'fetchGithubContent');

    server.registerTool(
        fetchGithubToolName,
        {
            description: "Fetch GitHub/Gitee by URL: README, one source file (/blob/), dir tree (/tree/), Issue, or PR. Example: https://github.com/o/r/blob/main/src/index.ts — ref can be branch/tag/commit; one file or dir per call, not a repo clone.",
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
                            text: withErrorHint(
                                'Content not found or target repository/item does not exist',
                                '读取单个文件用 /blob/<ref>/<path>；列目录用 /tree/<ref>/<path>；Issue 用 /issues/<n>；PR 用 /pull/<n>。ref 可为分支、tag 或 commit。'
                            )
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
                            isAppError(error) && error.hint
                                ? error.hint
                                : '若资源存在但抓取失败，可确认 URL 拼写，或配置 GITHUB_TOKEN 以提升 API 速率限制。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
}
