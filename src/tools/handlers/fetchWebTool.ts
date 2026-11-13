import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validatePublicWebUrl } from '../../core/validation/targetValidation.js';
import { validateExtractSchema } from '../../engines/web/extract.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import {
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

const normalizeUrlParam = (val: unknown): unknown => {
    if (typeof val === 'string') {
        return normalizeHttpUrl(val);
    }
    if (Array.isArray(val)) {
        return normalizeUrlsArray(val);
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

/** 结构化提取的字段定义（深层结构由 validateExtractSchema 在运行时递归校验） */
const extractFieldInput = z.object({
    name: z.string().min(1),
    selector: z.string().min(1).optional(),
    type: z.enum(['text', 'html', 'markdown', 'attribute', 'list']).optional(),
    attribute: z.string().min(1).optional(),
    fields: z.array(z.unknown()).optional(),
    all: z.boolean().optional()
}).passthrough();

const publicHttpUrlRefined = z.string().url().refine(
    (u) => {
        try {
            const parsed = new URL(u);
            return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && validatePublicWebUrl(u);
        } catch {
            return false;
        }
    },
    "URL must be a public HTTP(S) address (private/local network targets and non-HTTP protocols are blocked)"
);

export function registerFetchWebTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchWebToolName = 'fetchWebContent';

    server.registerTool(
        fetchWebToolName,
        {
            description: "Fetch readable web content/docs/PDFs. Auto-cleans ads, keeps code/tables. Supports outline mode & sectionId for long docs, BM25 focus, batch URLs (1-3), and startIndex paging.",
            inputSchema: z.object({
                url: z.preprocess(
                    normalizeUrlParam,
                    z.union([
                        publicHttpUrlRefined,
                        z.array(publicHttpUrlRefined).min(1).max(3)
                    ]).optional()
                ).describe("Public HTTP(S) URL or array of 1-3 URLs to fetch. Array fetches concurrently and splits maxChars budget"),
                urls: z.preprocess(normalizeUrlsArray, z.array(publicHttpUrlRefined).min(1).max(3).optional())
                    .describe("(Optional alias for url array) Batch URLs (1~3 URLs run concurrently)"),
                mode: z.enum(['full', 'outline']).optional()
                    .describe("Extraction mode: 'full' (default) returns content body; 'outline' returns H1-H4 heading tree with section slug IDs and char estimates — use on long docs to avoid burning tokens"),
                sectionId: z.string().min(1).optional()
                    .describe("Directly extract a specific section by heading slug ID or title (from outline mode). Reads until next same-level heading"),
                focus: z.string().min(1).optional()
                    .describe("Keyword or topic to target. Uses BM25 semantic scoring to rank and extract relevant paragraphs, saving tokens on long pages"),
                focusMode: z.enum(['bm25', 'window']).optional()
                    .describe("Focus scoring algorithm (default 'bm25'; 'window' keeps ±2500 char slice around first match)"),
                maxChars: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(1000).max(200000).default(30000))
                    .describe("Max characters to return (default 30000). Use with startIndex for paging"),
                startIndex: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(0).optional())
                    .describe("Character offset to start reading from. Use nextStartIndex from a previous response to page through long content"),
                format: z.enum(['markdown', 'text', 'raw']).optional()
                    .describe("Content format: 'markdown' (default, keeps headings, code blocks, tables), 'text' (compact plain text), or 'raw' (unprocessed HTML/source)"),
                citations: z.boolean().optional()
                    .describe("Rewrite inline links as numbered citations and append a '## References' list"),
                retainLinks: z.enum(['all', 'none', 'text']).optional()
                    .describe("Inline link style: 'all' (default), 'text' (strip URLs, saves tokens on index pages), 'none'"),
                selector: z.string().min(1).optional()
                    .describe("CSS selector to narrow extraction to a specific DOM subtree"),
                extract: z.object({
                    baseSelector: z.string().min(1).optional(),
                    fields: z.array(extractFieldInput).min(1).max(50)
                }).passthrough().optional()
                    .describe("Extract structured JSON via CSS selectors without LLM"),
                cache: z.enum(['default', 'reload']).optional()
                    .describe("Cache mode: 'default' uses disk Markdown cache; 'reload' forces re-fetching upstream"),
                readability: z.boolean().optional()
                    .describe("Force readability parser (default: auto-detected based on content)"),
                includeLinks: z.boolean().optional()
                    .describe("Include extracted links array in metadata"),
                raw: z.boolean().optional()
                    .describe("(Deprecated: use format='raw') Return raw response body without extraction"),
            }).passthrough(),
            annotations: TOOL_ANNOTATION_HINTS
        },
        async (rawArgs, extra) => {
            const {
                url,
                urls,
                focus,
                focusMode,
                mode,
                sectionId,
                citations,
                retainLinks,
                selector,
                extract,
                maxChars = 30000,
                cache,
                readability,
                includeLinks,
                raw,
                startIndex,
                format
            } = rawArgs as {
                url?: string | string[];
                urls?: string[];
                focus?: string;
                focusMode?: 'bm25' | 'window';
                mode?: 'full' | 'outline';
                sectionId?: string;
                citations?: boolean;
                retainLinks?: 'all' | 'none' | 'text';
                selector?: string;
                extract?: unknown;
                maxChars?: number;
                cache?: 'default' | 'reload';
                readability?: boolean;
                includeLinks?: boolean;
                raw?: boolean;
                startIndex?: number;
                format?: 'markdown' | 'text' | 'raw';
            } & Record<string, unknown>;
            const signal = extra?.signal;
            const knownKeys = ['url', 'urls', 'focus', 'focusMode', 'mode', 'sectionId', 'citations', 'retainLinks', 'selector', 'extract', 'maxChars', 'cache', 'readability', 'includeLinks', 'raw', 'startIndex', 'format'];
            const unknownWarnings = detectUnknownParameters(rawArgs as Record<string, unknown>, knownKeys);

            try {
                const extractSchema = extract === undefined ? undefined : validateExtractSchema(extract);

                let candidateUrls: string[] = [];
                const isExplicitBatch = (urls && urls.length > 0) || (Array.isArray(url) && url.length > 1);

                if (Array.isArray(url)) {
                    candidateUrls = url;
                } else if (typeof url === 'string' && url.trim().length > 0) {
                    candidateUrls = [url.trim()];
                } else if (Array.isArray(urls)) {
                    candidateUrls = urls;
                }

                const targetUrls: string[] = candidateUrls.slice(0, 3);
                if (targetUrls.length === 0) {
                    return {
                        content: [{ type: 'text', text: 'Provide a valid "url" (or array of 1-3 URLs).' }],
                        isError: true
                    };
                }

                const isRawMode = raw === true || format === 'raw';
                const effectiveFormat = format === 'raw' ? undefined : (format ?? (isRawMode ? undefined : 'markdown'));

                // 批量抓取模式（urls 模式或 url 为多个）
                if (isExplicitBatch || (urls && urls.length > 0)) {
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
                                raw: isRawMode,
                                startIndex,
                                format: effectiveFormat,
                                focus,
                                focusMode,
                                mode,
                                sectionId,
                                citations,
                                retainLinks,
                                ...(selector ? { selector } : {}),
                                ...(extractSchema ? { extract: extractSchema } : {}),
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
                    raw: isRawMode,
                    startIndex,
                    format: effectiveFormat,
                    focus,
                    focusMode,
                    mode,
                    sectionId,
                    citations,
                    retainLinks,
                    ...(selector ? { selector } : {}),
                    ...(extractSchema ? { extract: extractSchema } : {}),
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
