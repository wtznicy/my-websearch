import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isContext7QuotaExhaustedError, Context7DocsResult } from '../../engines/context7/context7.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import {
    logTool,
    logSafeError,
    withErrorHint,
    CONTEXT7_QUOTA_HINT,
    TOOL_ANNOTATION_HINTS,
    capTextResponse
} from '../toolShared.js';

export function formatContext7DocsAsMarkdown(result: Context7DocsResult): string {
    const lines: string[] = [];
    const titleParts = [`# Docs: ${result.libraryId}`];
    if (result.resolvedFrom) {
        titleParts.push(`(resolved from "${result.resolvedFrom}")`);
    } else if (result.redirectedFrom) {
        titleParts.push(`(redirected from "${result.redirectedFrom}")`);
    }
    lines.push(titleParts.join(' '));
    if (result.query) {
        lines.push(`> Query: ${result.query}`);
    }
    lines.push('');

    if (result.infoSnippets && result.infoSnippets.length > 0) {
        for (const info of result.infoSnippets) {
            if (info.content) {
                lines.push(info.content.trim());
                lines.push('');
            }
        }
    }

    if (result.codeSnippets && result.codeSnippets.length > 0) {
        for (const snippet of result.codeSnippets) {
            const pageTitle = snippet.pageTitle || 'Documentation';
            const codeTitle = snippet.codeTitle || '';
            const heading = codeTitle ? `### ${pageTitle}: ${codeTitle}` : `### ${pageTitle}`;
            lines.push(heading);
            if (snippet.codeDescription) {
                lines.push(snippet.codeDescription.trim());
            }
            if (Array.isArray(snippet.codeList) && snippet.codeList.length > 0) {
                for (const item of snippet.codeList) {
                    if (item.path) {
                        lines.push(`*File: ${item.path}*`);
                    }
                    const lang = item.language || '';
                    lines.push(`\`\`\`${lang}\n${(item.code || '').trim()}\n\`\`\``);
                    lines.push('');
                }
            } else if ((snippet as unknown as { code?: string; codeLanguage?: string }).code) {
                const legacy = snippet as unknown as { code?: string; codeLanguage?: string; language?: string };
                const lang = legacy.codeLanguage || legacy.language || '';
                lines.push(`\`\`\`${lang}\n${(legacy.code || '').trim()}\n\`\`\``);
                lines.push('');
            }
        }
    } else if (!result.infoSnippets || result.infoSnippets.length === 0) {
        lines.push('*No code snippets returned.*');
        lines.push('');
    }

    if (result.alternativeLibraries && result.alternativeLibraries.length > 0) {
        lines.push('---');
        lines.push('**Alternative Libraries:**');
        for (const alt of result.alternativeLibraries) {
            lines.push(`- **${alt.id}** (${alt.title})${alt.description ? `: ${alt.description}` : ''}`);
        }
        lines.push('');
    }

    return lines.join('\n').trim();
}

export function registerQueryDocsTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    server.registerTool(
        "queryDocs",
        {
            description: "PREFERRED for official documentation: get up-to-date, version-specific official docs and code snippets for any library, framework, or package (e.g. 'next.js', 'react', 'fastapi', or exact ID '/vercel/next.js'). Directly pass the package name — automatically resolves to the canonical library. Direct, reliable, no proxy needed.",
            inputSchema: {
                library: z.string().min(1).optional().describe("Library or package name (e.g. 'next.js', 'react', 'fastapi') or exact Context7 library ID (e.g. '/vercel/next.js', version-pinnable like '/vercel/next.js@v15.1.8')"),
                libraryId: z.string().min(1).optional().describe("Legacy alias for library (e.g. /vercel/next.js)"),
                query: z.string().min(1).optional().describe("The question, feature, or task to get relevant documentation for (optional; defaults to an overview when omitted, e.g. 'how to set up middleware with auth')"),
                limit: z.number().int().min(1).max(10).optional().describe("Maximum number of code snippets to return (default 5)")
            },
            annotations: TOOL_ANNOTATION_HINTS
        },
        async ({ library, libraryId, query, limit }) => {
            const target = (library ?? libraryId ?? '').trim();
            if (!target) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Invalid arguments: Either "library" or "libraryId" must be provided' }]
                };
            }
            try {
                logTool(`Context7 fetching docs for: ${target}`);
                const result = await runtime.services.context7Docs.execute({ library: target, query, limit });
                if (result.resolvedFrom) {
                    logTool(`Context7 resolved "${result.resolvedFrom}" -> ${result.libraryId}`);
                } else if (result.redirectedFrom) {
                    logTool(`Context7 library redirected: ${result.redirectedFrom} -> ${result.libraryId}`);
                }

                return {
                    content: [{
                        type: 'text',
                        text: capTextResponse(formatContext7DocsAsMarkdown(result))
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
                                : '可检查库名拼写（如 "next.js" 或 "/vercel/next.js"），或稍后重试。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
}
