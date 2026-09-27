import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateArticleUrl } from '../../core/validation/targetValidation.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import {
    getToolName,
    logTool,
    logSafeError,
    withErrorHint,
    capTextResponse,
    TOOL_ANNOTATION_HINTS
} from '../toolShared.js';

export function registerFetchCsdnTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchCsdnToolName = getToolName('MCP_TOOL_FETCH_CSDN_NAME', 'fetchCsdnArticle');

    server.tool(
        fetchCsdnToolName,
        "Fetch full article content from a CSDN article URL (blog.csdn.net /article/details/ only; for other sites use fetchWebContent)",
        {
            url: z.string().url().refine(
                (url) => validateArticleUrl(url, 'csdn'),
                "URL must be from blog.csdn.net contains /article/details/ path"
            )
        },
        TOOL_ANNOTATION_HINTS,
        async ({url}) => {
            try {
                logTool(`Fetching CSDN article: ${url}`);
                const result = await runtime.services.fetchCsdnArticle.execute({ url });

                return {
                    content: [{
                        type: 'text',
                        text: capTextResponse(result.content)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to fetch CSDN article', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch article: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            '可稍后重试，或确认 URL 是 blog.csdn.net 下的 /article/details/ 文章链接。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
}
