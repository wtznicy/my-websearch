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

export function registerResolveLibraryTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    server.tool(
        "resolveLibraryId",
        "PREFERRED for official docs: resolve a library/package name to a Context7 library ID (e.g. /vercel/next.js). Use this (then queryDocs) FIRST when the task needs official library/framework documentation — more reliable than web search and works without a proxy.",
        {
            libraryName: z.string().min(1).describe("The library or package name to search for (e.g. 'Next.js', 'express', 'prisma')"),
            query: z.string().min(1).optional().describe("The user's question or task, used to rank results by relevance (optional; defaults to the library name when omitted, e.g. 'how to implement authentication')"),
            limit: z.number().int().min(1).max(10).optional().describe("Maximum number of library matches to return (default 5)")
        },
        TOOL_ANNOTATION_HINTS,
        async ({libraryName, query, limit}) => {
            try {
                logTool(`Context7 resolving library: ${libraryName}`);
                const result = await runtime.services.context7Libraries.execute({ libraryName, query, limit });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            } catch (error) {
                logSafeError('Failed to resolve library via Context7', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to resolve library: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            isContext7QuotaExhaustedError(error)
                                ? CONTEXT7_QUOTA_HINT
                                : '可检查网络连通性（context7.com），或稍后重试。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
}
