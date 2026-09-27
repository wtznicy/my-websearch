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

export function registerFetchJuejinTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchJuejinToolName = getToolName('MCP_TOOL_FETCH_JUEJIN_NAME', 'fetchJuejinArticle');

    server.tool(
        fetchJuejinToolName,
        "Fetch full article content from a Juejin(掘金) post URL (juejin.cn or article.juejin.cn /post/ only; for other sites use fetchWebContent)",
        {
            url: z.string().url().refine(
                (url) => validateArticleUrl(url, 'juejin'),
                "URL must be from juejin.cn and contain /post/ path"
            ),
            format: z.enum(['text', 'markdown']).optional()
                .describe("Output format (default: text). 'markdown' keeps fenced code blocks (with language) and GFM tables — recommended for technical posts")
        },
        TOOL_ANNOTATION_HINTS,
        async ({url, format}) => {
            try {
                logTool(`Fetching Juejin article: ${url}`);
                const result = await runtime.services.fetchJuejinArticle.execute({ url, format });

                return {
                    content: [{
                        type: 'text',
                        text: capTextResponse(result.content)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to fetch Juejin article', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch article: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            '可稍后重试，或确认 URL 是 juejin.cn 下的 /post/ 文章链接。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
}
