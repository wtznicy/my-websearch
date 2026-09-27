import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validatePublicWebUrl } from '../../core/validation/targetValidation.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import {
    getToolName,
    logTool,
    logSafeError,
    withErrorHint,
    buildFetchWebErrorHint,
    serializeFetchWebResult,
    TOOL_ANNOTATION_HINTS
} from '../toolShared.js';

export function registerFetchWebTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchWebToolName = getToolName('MCP_TOOL_FETCH_WEB_NAME', 'fetchWebContent');

    server.tool(
        fetchWebToolName,
        "Fetch content from a public HTTP(S) URL (supports Markdown files and normal web pages)",
        {
            url: z.string().url().refine(
                (url) => validatePublicWebUrl(url),
                "URL must be a public HTTP(S) address (private/local network targets are blocked)"
            ),
            maxChars: z.number().int().min(1000).max(200000).default(30000),
            readability: z.boolean().optional(),
            includeLinks: z.boolean().optional(),
            raw: z.boolean().optional().describe("Return the raw response body (HTML/plain text) without extraction"),
            startIndex: z.number().int().min(0).optional().describe("Character offset to start reading from (for paging through long content)"),
            format: z.enum(['text', 'markdown']).optional().describe("Content format: 'markdown' preserves fenced code blocks (with language) and GFM tables — better for technical docs"),
        },
        TOOL_ANNOTATION_HINTS,
        async ({url, maxChars = 30000, readability, includeLinks, raw, startIndex, format}) => {
            try {
                logTool(`Fetching web content: ${url}`);
                const result = await runtime.services.fetchWeb.execute({ url, maxChars, readability, includeLinks, raw, startIndex, format });

                return {
                    content: [{
                        type: 'text',
                        text: serializeFetchWebResult(result)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to fetch web content', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch web content: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            buildFetchWebErrorHint(error)
                        )
                    }],
                    isError: true
                };
            }
        }
    );
}
