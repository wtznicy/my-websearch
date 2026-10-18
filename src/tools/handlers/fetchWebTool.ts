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
        // 仅在无 scheme（如 example.com/path）时补全 https://，已有 scheme（如 file:, ftp:, http:, https:）时不篡改，
        // 确保非 HTTP 协议（如 file://）能被 schema 校验准确拦截（P2-5）
        if (s && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(s) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(s)) {
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

import { detectUnknownParameters } from '../../utils/toolValidation.js';

export function registerFetchWebTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchWebToolName = getToolName('MCP_TOOL_FETCH_WEB_NAME', 'fetchWebContent');

    server.registerTool(
        fetchWebToolName,
        {
            description: "Fetch readable web content/docs/PDFs from public URLs. Auto-cleans ads, preserves code blocks/tables, defaults to markdown. Supports batch urls (1-3), focus keyword, cache control, and pagination via startIndex.",
            inputSchema: z.object({
                url: z.preprocess(normalizeHttpUrl, z.string().url().refine(
                    (u) => {
                        try {
                            const parsed = new URL(u);
                            return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && validatePublicWebUrl(u);
                        } catch {
                            return false;
                        }
                    },
                    "URL must be a public HTTP(S) address (private/local network targets and non-HTTP protocols are blocked)"
                ).optional()),
                urls: z.preprocess(normalizeUrlsArray, z.array(
                    z.string().url().refine(
                        (u) => {
                            try {
                                const parsed = new URL(u);
                                return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && validatePublicWebUrl(u);
                            } catch {
                                return false;
                            }
                        },
                        "Each URL must be a public HTTP(S) address"
                    )
                ).min(1).max(3).optional())
                    .describe("Batch URLs (1~3 URLs run concurrently, splitting maxChars budget; ideal for comparing search results)"),
                focus: z.string().min(1).optional()
                    .describe("Keyword or section name to target (e.g. 'Auth', 'Config'); returns targeted window (~5000 chars) instead of burning tokens on full document"),
                maxChars: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(1000).max(200000).default(30000)),
                cache: z.enum(['default', 'reload']).optional()
                    .describe("Cache mode: 'default' uses disk Markdown cache; 'reload' forces re-fetching upstream"),
                readability: z.boolean().optional(),
                includeLinks: z.boolean().optional(),
                raw: z.boolean().optional().describe("Return the raw response body (HTML/plain text) without extraction"),
                startIndex: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(0).optional())
                    .describe("Character offset to start reading from (for paging through long content)"),
                format: z.enum(['text', 'markdown']).optional().describe("Content format (default: 'markdown' when raw is false): 'markdown' preserves headings, lists, fenced code blocks (with language) and GFM tables — better for technical docs; use 'text' for plain text"),
            }).passthrough(),
            annotations: TOOL_ANNOTATION_HINTS
        },
        async (rawArgs, extra) => {
            const { url, urls, focus, maxChars = 30000, cache, readability, includeLinks, raw, startIndex, format } = rawArgs as {
                url?: string;
                urls?: string[];
                focus?: string;
                maxChars?: number;
                cache?: 'default' | 'reload';
                readability?: boolean;
                includeLinks?: boolean;
                raw?: boolean;
                startIndex?: number;
                format?: 'markdown' | 'text';
            } & Record<string, unknown>;
            const signal = extra?.signal;
            const knownKeys = ['url', 'urls', 'focus', 'maxChars', 'cache', 'readability', 'includeLinks', 'raw', 'startIndex', 'format'];
            const unknownWarnings = detectUnknownParameters(rawArgs as Record<string, unknown>, knownKeys);

            try {
                const targetUrls: string[] = (urls && urls.length > 0 ? urls : (url ? [url] : [])).slice(0, 3);
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
                        targetUrls.map((targetUrl: string) =>
                            runtime.services.fetchWeb.execute({
                                url: targetUrl,
                                maxChars: perUrlMaxChars,
                                cache,
                                readability,
                                includeLinks,
                                raw,
                                startIndex,
                                format: effectiveFormat,
                                focus,
                                signal
                            })
                        )
                    );

                    const batchResults = targetUrls.map((targetUrl: string, idx: number) => {
                        const item = settled[idx];
                        if (item && item.status === 'fulfilled') {
                            const val = item.value;
                            if (unknownWarnings.length > 0) {
                                val.warnings = [...new Set([...(val.warnings ?? []), ...unknownWarnings])];
                            }
                            return val;
                        }
                        const err = item && item.status === 'rejected' ? item.reason : null;
                        return {
                            url: targetUrl,
                            error: err instanceof Error ? err.message : String(err || 'Failed to fetch'),
                            ...(unknownWarnings.length > 0 ? { warnings: unknownWarnings } : {})
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
                    cache,
                    readability,
                    includeLinks,
                    raw,
                    startIndex,
                    format: effectiveFormat,
                    focus,
                    signal
                });

                if (unknownWarnings.length > 0) {
                    result.warnings = [...new Set([...(result.warnings ?? []), ...unknownWarnings])];
                }

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
