import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isContext7QuotaExhaustedError } from '../../engines/context7/context7.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import {
    logTool,
    logSafeError,
    withErrorHint,
    CONTEXT7_QUOTA_HINT,
    TOOL_ANNOTATION_HINTS
} from '../toolShared.js';

export function registerQueryDocsTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    server.tool(
        "queryDocs",
        "Get up-to-date, version-specific official docs and code snippets for a Context7 library ID (e.g. /vercel/next.js, version-pinnable like /vercel/next.js@v15.1.8). Use with resolveLibraryId for official documentation lookups — direct, reliable, no proxy needed.",
        {
            libraryId: z.string().min(1).refine(
                (v) => v.startsWith('/'),
                "libraryId must start with '/' (e.g. /vercel/next.js)"
            ).describe("Exact Context7-compatible library ID (e.g. /vercel/next.js, /packages/express; optional version like /vercel/next.js@v15.1.8)"),
            query: z.string().min(1).optional().describe("The question or task to get relevant documentation for (optional; defaults to an overview when omitted, e.g. 'how to set up middleware with auth')"),
            limit: z.number().int().min(1).max(10).optional().describe("Maximum number of code snippets to return (default 5)")
        },
        TOOL_ANNOTATION_HINTS,
        async ({libraryId, query, limit}) => {
            try {
                logTool(`Context7 fetching docs for: ${libraryId}`);
                const result = await runtime.services.context7Docs.execute({ libraryId, query, limit });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to fetch docs via Context7', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch docs: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            isContext7QuotaExhaustedError(error)
                                ? CONTEXT7_QUOTA_HINT
                                : '可先用 resolveLibraryId 确认 libraryId 正确，或稍后重试。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
}
