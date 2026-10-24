import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isContext7QuotaExhaustedError, Context7DocsResult, Context7InfoSnippet, Context7CodeSnippet } from '../../engines/context7/context7.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { fetchPackageDocsFallback, PackageDocsFallbackResult } from '../../core/docs/packageDocsFallback.js';
import { docsCacheKey, getDocsCache, setDocsCache } from '../../core/docs/docsCache.js';
import { metrics } from '../../core/metrics.js';
import {
    logTool,
    logSafeError,
    withErrorHint,
    CONTEXT7_QUOTA_HINT,
    TOOL_ANNOTATION_HINTS,
    capTextResponse
} from '../toolShared.js';

export type QueryDocsFormattedInput = {
    libraryId: string;
    query?: string;
    source?: 'context7' | 'npm' | 'pypi' | 'crates' | 'go' | 'github-readme';
    confidence?: 'high' | 'medium' | 'low';
    warnings?: string[];
    resolvedFrom?: string;
    redirectedFrom?: string;
    repositoryUrl?: string;
    readme?: string;
    infoSnippets?: Context7InfoSnippet[];
    codeSnippets?: Context7CodeSnippet[];
    alternativeLibraries?: Array<{ id: string; title: string; description?: string }>;
};

export function formatQueryDocsMarkdown(result: QueryDocsFormattedInput): string {
    const lines: string[] = [];
    const titleParts = [`# Docs: ${result.libraryId}`];
    if (result.resolvedFrom) {
        titleParts.push(`(resolved from "${result.resolvedFrom}")`);
    } else if (result.redirectedFrom) {
        titleParts.push(`(redirected from "${result.redirectedFrom}")`);
    }
    lines.push(titleParts.join(' '));

    const source = result.source ?? 'context7';
    const confidence = result.confidence ?? 'high';
    lines.push(`> Source: ${source} | Confidence: ${confidence}`);
    if (result.repositoryUrl) {
        lines.push(`> Repository: ${result.repositoryUrl}`);
    }
    if (result.query) {
        lines.push(`> Query: ${result.query}`);
    }
    lines.push('');

    if (result.warnings && result.warnings.length > 0) {
        for (const warning of result.warnings) {
            lines.push(`> ⚠️ **Warning:** ${warning}`);
        }
        lines.push('');
    }

    if (result.readme) {
        lines.push(result.readme);
        return lines.join('\n').trim();
    }

    if (confidence === 'low' && (!result.codeSnippets || result.codeSnippets.length === 0)) {
        lines.push('> ⚠️ **Warning: Low Match Confidence**');
        lines.push(`> The query "${result.resolvedFrom ?? result.libraryId}" did not closely match any official library name. The closest candidate found was **\`${result.libraryId}\`**, which may be unrelated.`);
        if (result.alternativeLibraries && result.alternativeLibraries.length > 0) {
            lines.push(`> Alternatives: ${result.alternativeLibraries.map((a) => `\`${a.id}\``).join(', ')}`);
        }
        lines.push('');
    }

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

export function formatContext7DocsAsMarkdown(result: Context7DocsResult): string {
    return formatQueryDocsMarkdown({
        libraryId: result.libraryId,
        query: result.query,
        source: 'context7',
        confidence: result.matchConfidence ?? 'high',
        resolvedFrom: result.resolvedFrom,
        redirectedFrom: result.redirectedFrom,
        infoSnippets: result.infoSnippets,
        codeSnippets: result.codeSnippets,
        alternativeLibraries: result.alternativeLibraries
    });
}

import { detectUnknownParameters } from '../../utils/toolValidation.js';

export function registerQueryDocsTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    server.registerTool(
        "queryDocs",
        {
            description: "Get official docs, API references, and code snippets for libraries/packages (e.g. 'react', 'fastapi', 'next.js'). Queries Context7 with fallback to npm/PyPI registry and GitHub README. Direct, no proxy needed.",
            inputSchema: z.object({
                library: z.string().min(1).optional().describe("Library or package name (e.g. 'next.js', 'react', 'fastapi') or exact Context7 library ID (e.g. '/vercel/next.js', version-pinnable like '/vercel/next.js@v15.1.8')"),
                libraryId: z.string().min(1).optional().describe("Legacy alias for library (e.g. /vercel/next.js)"),
                version: z.string().min(1).optional().describe("Optional explicit version (e.g. '14.2.0' or 'v15.1.8'); overrides an @version embedded in library"),
                query: z.string().min(1).optional().describe("The question, feature, or task to get relevant documentation for (optional; defaults to an overview when omitted, e.g. 'how to set up middleware with auth')"),
                limit: z.number().int().min(1).max(10).optional().describe("Maximum number of code snippets to return (default 5)"),
                cache: z.enum(['default', 'reload']).optional().describe("Use the 24h local docs cache (default) or bypass/refresh it with 'reload'"),
                strict: z.boolean().optional().describe("If true, rejects low-confidence library name matches with an error instead of returning loosely matched candidate docs (default false)")
            }).passthrough(),
            annotations: TOOL_ANNOTATION_HINTS
        },
        async (rawArgs, extra) => {
            const { library, libraryId, version, query, limit, strict, cache } = rawArgs as {
                library?: string;
                libraryId?: string;
                version?: string;
                query?: string;
                limit?: number;
                strict?: boolean;
                cache?: 'default' | 'reload';
            } & Record<string, unknown>;
            const unknownWarnings = detectUnknownParameters(rawArgs as Record<string, unknown>, ['library', 'libraryId', 'version', 'query', 'limit', 'strict', 'cache']);
            const target = (library ?? libraryId ?? '').trim();
            if (!target) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Invalid arguments: Either "library" or "libraryId" must be provided' }]
                };
            }

            const signal = extra?.signal;

            const cacheKey = docsCacheKey({ library: target, version, query, limit, strict });
            if (cache !== 'reload') {
                const cached = getDocsCache(cacheKey);
                if (cached) {
                    logTool(`queryDocs cache hit: ${cacheKey}`);
                    return {
                        content: [{ type: 'text', text: cached.text }],
                        source: cached.source,
                        confidence: cached.confidence,
                        cached: true,
                        warnings: unknownWarnings
                    } as unknown as { content: Array<{ type: 'text'; text: string }> };
                }
            }

            // 1. 尝试 Context7 查询
            let context7Result: Context7DocsResult | null = null;
            let context7Error: unknown = null;

            try {
                logTool(`Context7 fetching docs for: ${target}`);
                context7Result = await runtime.services.context7Docs.execute({
                    library: target,
                    version,
                    query,
                    limit,
                    strict,
                    signal
                });
                if (context7Result.resolvedFrom) {
                    logTool(`Context7 resolved "${context7Result.resolvedFrom}" -> ${context7Result.libraryId}`);
                } else if (context7Result.redirectedFrom) {
                    logTool(`Context7 library redirected: ${context7Result.redirectedFrom} -> ${context7Result.libraryId}`);
                }
            } catch (error) {
                context7Error = error;
            }

            // 2. 检查匹配质量：若高/中置信度命中，直接返回
            if (context7Result && context7Result.matchConfidence !== 'low') {
                const confidence = context7Result.matchConfidence ?? 'high';
                metrics.recordQueryDocsAttempt('context7', false);
                const text = capTextResponse(formatQueryDocsMarkdown({
                    libraryId: context7Result.libraryId,
                    query: context7Result.query,
                    source: 'context7',
                    confidence,
                    resolvedFrom: context7Result.resolvedFrom,
                    redirectedFrom: context7Result.redirectedFrom,
                    infoSnippets: context7Result.infoSnippets,
                    codeSnippets: context7Result.codeSnippets,
                    alternativeLibraries: context7Result.alternativeLibraries,
                    warnings: [...(context7Result.warnings ?? []), ...unknownWarnings]
                }));
                setDocsCache(cacheKey, { text, source: 'context7', confidence, cachedAt: Date.now() });
                return {
                    content: [{ type: 'text', text }],
                    source: 'context7',
                    confidence,
                    warnings: unknownWarnings
                } as unknown as { content: Array<{ type: 'text'; text: string }> };
            }

            // 3. 低置信度拦截或未命中时，启动兜底链：npm -> PyPI -> crates.io -> Go module proxy -> GitHub README
            logTool(`Context7 match confidence is low or failed for "${target}". Attempting npm/PyPI/crates/Go fallback...`);
            let fallbackResult: PackageDocsFallbackResult | null = null;
            try {
                fallbackResult = await fetchPackageDocsFallback({
                    library: target,
                    version,
                    signal,
                    fetchGithub: async (url) => runtime.services.fetchGithubReadme.execute({ url })
                });
            } catch (fbErr) {
                logSafeError('Fallback package docs resolution failed', fbErr);
            }

            if (fallbackResult) {
                logTool(`Fallback succeeded via ${fallbackResult.source}: ${fallbackResult.repositoryUrl}`);
                metrics.recordQueryDocsAttempt(fallbackResult.source, true);
                const combinedWarnings = [...new Set([...fallbackResult.warnings, ...unknownWarnings])];
                const text = capTextResponse(formatQueryDocsMarkdown({
                    libraryId: fallbackResult.libraryId,
                    query,
                    source: fallbackResult.source,
                    confidence: fallbackResult.confidence,
                    repositoryUrl: fallbackResult.repositoryUrl,
                    readme: fallbackResult.readme,
                    warnings: combinedWarnings
                }));
                if (fallbackResult.confidence !== 'low') {
                    setDocsCache(cacheKey, {
                        text,
                        source: fallbackResult.source,
                        confidence: fallbackResult.confidence,
                        cachedAt: Date.now()
                    });
                }
                return {
                    content: [{ type: 'text', text }],
                    source: fallbackResult.source,
                    confidence: fallbackResult.confidence,
                    warnings: combinedWarnings
                } as unknown as { content: Array<{ type: 'text'; text: string }> };
            }

            // 4. 兜底链也未找到包信息
            // 4a. 如果原本有低置信度 Context7 候选且非 strict 模式
            if (context7Result && !strict) {
                metrics.recordQueryDocsAttempt('context7', false);
                const warnings = [
                    `Low match confidence: "${target}" did not closely match any official library. Closest Context7 candidate was "${context7Result.libraryId}".`,
                    ...unknownWarnings
                ];
                const text = capTextResponse(formatQueryDocsMarkdown({
                    libraryId: context7Result.libraryId,
                    query: context7Result.query,
                    source: 'context7',
                    confidence: 'low',
                    resolvedFrom: context7Result.resolvedFrom,
                    redirectedFrom: context7Result.redirectedFrom,
                    infoSnippets: context7Result.infoSnippets,
                    codeSnippets: context7Result.codeSnippets,
                    alternativeLibraries: context7Result.alternativeLibraries,
                    warnings
                }));
                return {
                    content: [{ type: 'text', text }],
                    source: 'context7',
                    confidence: 'low',
                    warnings
                } as unknown as { content: Array<{ type: 'text'; text: string }> };
            }

            // 4b. 严格模式或 Context7 报错
            const finalErr = context7Error || new Error(`No official documentation found for library "${target}" on Context7, npm registry, or PyPI.`);
            logSafeError('Failed to fetch docs via Context7 and package fallbacks', finalErr);
            return {
                content: [{
                    type: 'text',
                    text: withErrorHint(
                        `Failed to fetch docs: ${finalErr instanceof Error ? finalErr.message : 'Unknown error'}`,
                        isContext7QuotaExhaustedError(finalErr)
                            ? CONTEXT7_QUOTA_HINT
                            : '可检查库名拼写（如 "next.js" 或 "/vercel/next.js"），或用 fetchGithubContent 直接读取其 GitHub 仓库 README/源码。'
                    )
                }],
                isError: true
            };
        }
    );
}
