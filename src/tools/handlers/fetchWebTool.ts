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

const normalizeHttpUrl = (val: unknown): unknown => {
    if (typeof val === 'string') {
        let s = val.trim();
        if (s && !/^https?:\/\//i.test(s)) {
            s = 'https://' + s;
        }
        return s;
    }
    return val;
};

const normalizeUrlsArray = (val: unknown): unknown => {
    if (typeof val === 'string') {
        val = val.split(',').map((item) => item.trim()).filter(Boolean);
    }
    if (Array.isArray(val)) {
        return val.map((item) => typeof item === 'string' ? (normalizeHttpUrl(item) as string) : item);
    }
    return val;
};

export function registerFetchWebTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchWebToolName = getToolName('MCP_TOOL_FETCH_WEB_NAME', 'fetchWebContent');

    server.registerTool(
        fetchWebToolName,
        {
            description: "Fetch readable content from a public HTTP(S) URL (web pages, technical docs, and Markdown files). Defaults to format='markdown' to preserve headings, code blocks (with language), and GFM tables. Supports focus='keyword' for chapter targeting (~5000 chars) and batch 'urls' (1~3 URLs concurrently). When response has truncated=true, inspect 'toc' for heading offsets or pass nextStartIndex as startIndex.",
            inputSchema: {
                url: z.preprocess(normalizeHttpUrl, z.string().url().refine(
                    (u) => validatePublicWebUrl(u),
                    "URL must be a public HTTP(S) address (private/local network targets are blocked)"
                ).optional()),
                urls: z.preprocess(normalizeUrlsArray, z.array(
                    z.string().url().refine(
                        (u) => validatePublicWebUrl(u),
                        "Each URL must be a public HTTP(S) address"
                    )
                ).min(1).max(3).optional())
                    .describe("Batch URLs (1~3 URLs run concurrently, splitting maxChars budget; ideal for comparing search results)"),
                focus: z.string().min(1).optional()
                    .describe("Keyword or section name to target (e.g. 'Auth', 'Config'); returns targeted window (~5000 chars) instead of burning tokens on full document"),
                maxChars: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(1000).max(200000).default(30000)),
                readability: z.boolean().optional(),
                includeLinks: z.boolean().optional(),
                raw: z.boolean().optional().describe("Return the raw response body (HTML/plain text) without extraction"),
                startIndex: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(0).optional())
                    .describe("Character offset to start reading from (for paging through long content)"),
                format: z.enum(['text', 'markdown']).optional().describe("Content format (default: 'markdown' when raw is false): 'markdown' preserves headings, lists, fenced code blocks (with language) and GFM tables — better for technical docs; use 'text' for plain text"),
            },
            annotations: TOOL_ANNOTATION_HINTS
        },
        async ({ url, urls, focus, maxChars = 30000, readability, includeLinks, raw, startIndex, format }) => {
            try {
                const targetUrls = (urls && urls.length > 0 ? urls : (url ? [url] : [])).slice(0, 3);
                if (targetUrls.length === 0) {
                    return {
                        content: [{ type: 'text', text: 'Provide either "url" or "urls" (1-3 URLs).' }],
                        isError: true
                    };
                }

                const effectiveFormat = format ?? (raw ? undefined : 'markdown');

                // 批量抓取模式（urls 模式）
                if (urls && urls.length > 0) {
                    logTool(`Fetching batch web content (${targetUrls.length} URLs): ${targetUrls.join(', ')}`);
                    const perUrlMaxChars = Math.floor(Math.min(maxChars, 60000) / targetUrls.length);
                    const settled = await Promise.allSettled(
                        targetUrls.map((targetUrl) =>
                            runtime.services.fetchWeb.execute({
                                url: targetUrl,
                                maxChars: perUrlMaxChars,
                                readability,
                                includeLinks,
                                raw,
                                startIndex,
                                format: effectiveFormat,
                                focus
                            })
                        )
                    );

                    const batchResults = targetUrls.map((targetUrl, idx) => {
                        const item = settled[idx];
                        if (item && item.status === 'fulfilled') {
                            return item.value;
                        }
                        const err = item && item.status === 'rejected' ? item.reason : null;
                        return {
                            url: targetUrl,
                            error: err instanceof Error ? err.message : String(err || 'Failed to fetch')
                        };
                    });

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ urls: targetUrls, results: batchResults }, null, 2)
                        }]
                    };
                }

                // 单 URL 模式
                const singleUrl = targetUrls[0]!;
                logTool(`Fetching web content: ${singleUrl}${focus ? ` (focus: "${focus}")` : ''}`);
                const result = await runtime.services.fetchWeb.execute({
                    url: singleUrl,
                    maxChars,
                    readability,
                    includeLinks,
                    raw,
                    startIndex,
                    format: effectiveFormat,
                    focus
                });

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
