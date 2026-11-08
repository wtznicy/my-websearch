import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isContext7QuotaExhaustedError, Context7DocsResult, Context7InfoSnippet, Context7CodeSnippet } from '../../engines/context7/context7.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { fetchPackageDocsFallback, PackageDocsFallbackResult, resolvePackageMetadata } from '../../core/docs/packageDocsFallback.js';
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
import { detectUnknownParameters } from '../../utils/toolValidation.js';

export type QueryDocsFormattedInput = {
    libraryId: string;
    query?: string;
    source?: 'context7' | 'npm' | 'pypi' | 'crates' | 'go' | 'maven' | 'github-readme' | 'official' | 'docs.rs' | 'pkg.go.dev' | 'github';
    confidence?: 'high' | 'medium' | 'low';
    warnings?: string[];
    resolvedFrom?: string;
    redirectedFrom?: string;
    repositoryUrl?: string;
    documentationUrl?: string;
    readme?: string;
    content?: string;
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
    if (result.documentationUrl) {
        lines.push(`> Documentation: ${result.documentationUrl}`);
    }
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

    if (result.content) {
        lines.push(result.content);
        return lines.join('\n').trim();
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

export function getContext7FallbackNotice(options: {
    context7Error?: unknown;
    context7Result?: Context7DocsResult | null;
    target: string;
    destination: string;
}): string {
    const { context7Error, context7Result, target, destination } = options;
    if (context7Error) {
        if (isContext7QuotaExhaustedError(context7Error)) {
            return `Context7 monthly quota exhausted (HTTP 402). Automatically switched to ${destination}. Configure CONTEXT7_API_KEY in ~/.my-websearch/config.json to restore Context7 access.`;
        }
        const msg = context7Error instanceof Error ? context7Error.message : String(context7Error);
        return `Context7 service temporarily unavailable (${msg}). Automatically failed over to ${destination}.`;
    }
    if (context7Result && context7Result.matchConfidence === 'low') {
        const closest = context7Result.libraryId ? ` (closest candidate: "${context7Result.libraryId}")` : '';
        return `Library "${target}" was not indexed by Context7 or match confidence was low${closest}. Automatically retrieved from ${destination}.`;
    }
    return `Context7 did not return valid documentation for "${target}". Automatically switched to ${destination}.`;
}

export function registerQueryDocsTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    server.registerTool(
        "queryDocs",
        {
            description: "Get official docs, API references, and code snippets for libraries/packages (e.g. 'react', 'fastapi', 'tokio'). Supports multi-source selection ('auto', 'official', 'docs.rs', 'pkg.go.dev', 'context7', 'npm', 'pypi'). Direct, no proxy needed.",
            inputSchema: z.object({
                library: z.string().min(1).optional().describe("Library or package name (e.g. 'next.js', 'react', 'fastapi', 'tokio') or exact Context7 library ID (e.g. '/vercel/next.js', version-pinnable like '/vercel/next.js@v15.1.8')"),
                libraryId: z.string().min(1).optional().describe("Legacy alias for library (e.g. /vercel/next.js)"),
                version: z.string().min(1).optional().describe("Optional explicit version (e.g. '14.2.0' or 'v15.1.8'); overrides an @version embedded in library"),
                query: z.string().min(1).optional().describe("The question, feature, or task to get relevant documentation for (optional; defaults to an overview when omitted, e.g. 'how to set up middleware with auth')"),
                source: z.enum([
                    'auto',
                    'context7',
                    'official',
                    'docs.rs',
                    'pkg.go.dev',
                    'npm',
                    'pypi',
                    'github'
                ]).optional().default('auto').describe("Documentation source: 'auto' (default: Context7 with smart fallback to official doc site and registries), 'official' (direct official documentation website), 'docs.rs' (Rust), 'pkg.go.dev' (Go), 'context7', 'npm', 'pypi', 'github'"),
                limit: z.number().int().min(1).max(10).optional().describe("Maximum number of code snippets or sections to return (default 5)"),
                cache: z.enum(['default', 'reload']).optional().describe("Use the 24h local docs cache (default) or bypass/refresh it with 'reload'"),
                strict: z.boolean().optional().describe("If true, rejects low-confidence library name matches with an error instead of returning loosely matched candidate docs (default false)")
            }).passthrough(),
            annotations: TOOL_ANNOTATION_HINTS
        },
        async (rawArgs, extra) => {
            const { library, libraryId, version, query, limit, strict, cache, source: rawSource } = rawArgs as {
                library?: string;
                libraryId?: string;
                version?: string;
                query?: string;
                limit?: number;
                strict?: boolean;
                cache?: 'default' | 'reload';
                source?: 'auto' | 'context7' | 'official' | 'docs.rs' | 'pkg.go.dev' | 'npm' | 'pypi' | 'github';
            } & Record<string, unknown>;

            const unknownWarnings = detectUnknownParameters(rawArgs as Record<string, unknown>, [
                'library',
                'libraryId',
                'version',
                'query',
                'limit',
                'strict',
                'cache',
                'source'
            ]);

            const target = (library ?? libraryId ?? '').trim();
            if (!target) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Invalid arguments: Either "library" or "libraryId" must be provided' }]
                };
            }

            const reqSource = (rawSource || 'auto').toLowerCase();
            const signal = extra?.signal;

            const cacheKey = docsCacheKey({ library: target, version, query, limit, strict, source: reqSource });
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

            const fetchViaWeb = async (url: string): Promise<string | null> => {
                try {
                    const res = await runtime.services.fetchWeb.execute({
                        url,
                        maxChars: 30000,
                        format: 'markdown',
                        readability: true,
                        signal
                    });
                    if (res.content && res.content.trim().length > 20) {
                        return res.content.trim();
                    }
                } catch (err) {
                    logSafeError(`fetchViaWeb readability pass failed for ${url}`, err);
                }

                try {
                    const resFallback = await runtime.services.fetchWeb.execute({
                        url,
                        maxChars: 30000,
                        format: 'markdown',
                        readability: false,
                        signal
                    });
                    if (resFallback.content && resFallback.content.trim().length > 20) {
                        return resFallback.content.trim();
                    }
                } catch (err) {
                    logSafeError(`fetchViaWeb raw pass failed for ${url}`, err);
                }

                return null;
            };

            // 1. 显式指定 docs.rs
            if (reqSource === 'docs.rs') {
                const clean = target.replace(/^crates?:/, '').trim().split('@')[0]?.trim() || target;
                const url = version
                    ? `https://docs.rs/${encodeURIComponent(clean)}/${encodeURIComponent(version)}`
                    : `https://docs.rs/${encodeURIComponent(clean)}`;
                logTool(`queryDocs fetching docs.rs directly: ${url}`);
                const content = await fetchViaWeb(url);
                if (content) {
                    metrics.recordQueryDocsAttempt('docs.rs', false);
                    const text = capTextResponse(formatQueryDocsMarkdown({
                        libraryId: clean,
                        query,
                        source: 'docs.rs',
                        confidence: 'high',
                        documentationUrl: url,
                        content,
                        warnings: unknownWarnings
                    }));
                    setDocsCache(cacheKey, { text, source: 'docs.rs', confidence: 'high', cachedAt: Date.now() });
                    return {
                        content: [{ type: 'text', text }],
                        source: 'docs.rs',
                        confidence: 'high',
                        warnings: unknownWarnings
                    } as unknown as { content: Array<{ type: 'text'; text: string }> };
                }
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch documentation from docs.rs for "${clean}"`,
                            `Please verify the crate name on crates.io or check if version "${version ?? ''}" is published.`
                        )
                    }],
                    isError: true
                };
            }

            // 2. 显式指定 pkg.go.dev
            if (reqSource === 'pkg.go.dev') {
                const clean = target.replace(/^go:/, '').trim().split('@')[0]?.trim() || target;
                const url = version
                    ? `https://pkg.go.dev/${clean}@${encodeURIComponent(version)}`
                    : `https://pkg.go.dev/${clean}`;
                logTool(`queryDocs fetching pkg.go.dev directly: ${url}`);
                const content = await fetchViaWeb(url);
                if (content) {
                    metrics.recordQueryDocsAttempt('pkg.go.dev', false);
                    const text = capTextResponse(formatQueryDocsMarkdown({
                        libraryId: clean,
                        query,
                        source: 'pkg.go.dev',
                        confidence: 'high',
                        documentationUrl: url,
                        content,
                        warnings: unknownWarnings
                    }));
                    setDocsCache(cacheKey, { text, source: 'pkg.go.dev', confidence: 'high', cachedAt: Date.now() });
                    return {
                        content: [{ type: 'text', text }],
                        source: 'pkg.go.dev',
                        confidence: 'high',
                        warnings: unknownWarnings
                    } as unknown as { content: Array<{ type: 'text'; text: string }> };
                }
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch documentation from pkg.go.dev for "${clean}"`,
                            `Please verify the Go module path (e.g. "github.com/gin-gonic/gin" or "golang.org/x/sync").`
                        )
                    }],
                    isError: true
                };
            }

            // 3. 显式指定 official 官方文档站
            if (reqSource === 'official') {
                logTool(`queryDocs resolving official documentation site for: ${target}`);
                const meta = await resolvePackageMetadata(target, { signal, version });
                const docUrl = meta?.documentationUrl || (meta?.homepageUrl && !meta.homepageUrl.includes('github.com') && !meta.homepageUrl.includes('gitee.com') ? meta.homepageUrl : null);

                if (docUrl) {
                    const content = await fetchViaWeb(docUrl);
                    if (content) {
                        metrics.recordQueryDocsAttempt('official', false);
                        const text = capTextResponse(formatQueryDocsMarkdown({
                            libraryId: meta?.libraryId || target,
                            query,
                            source: 'official',
                            confidence: 'high',
                            documentationUrl: docUrl,
                            repositoryUrl: meta?.repositoryUrl || undefined,
                            content,
                            warnings: unknownWarnings
                        }));
                        setDocsCache(cacheKey, { text, source: 'official', confidence: 'high', cachedAt: Date.now() });
                        return {
                            content: [{ type: 'text', text }],
                            source: 'official',
                            confidence: 'high',
                            warnings: unknownWarnings
                        } as unknown as { content: Array<{ type: 'text'; text: string }> };
                    }
                }

                logTool(`Official doc site not available for "${target}". Falling back to repository README...`);
                const fallback = await fetchPackageDocsFallback({
                    library: target,
                    version,
                    signal,
                    fetchGithub: async (url) => runtime.services.fetchGithubReadme.execute({ url }),
                    reasonHint: `No standalone documentation website found for "${target}".`
                });
                if (fallback) {
                    metrics.recordQueryDocsAttempt('official', true);
                    const combinedWarnings = [...new Set([...fallback.warnings, ...unknownWarnings])];
                    const text = capTextResponse(formatQueryDocsMarkdown({
                        libraryId: fallback.libraryId,
                        query,
                        source: fallback.source,
                        confidence: fallback.confidence,
                        repositoryUrl: fallback.repositoryUrl,
                        readme: fallback.readme,
                        warnings: combinedWarnings
                    }));
                    if (fallback.confidence !== 'low') {
                        setDocsCache(cacheKey, { text, source: fallback.source, confidence: fallback.confidence, cachedAt: Date.now() });
                    }
                    return {
                        content: [{ type: 'text', text }],
                        source: fallback.source,
                        confidence: fallback.confidence,
                        warnings: combinedWarnings
                    } as unknown as { content: Array<{ type: 'text'; text: string }> };
                }

                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to locate official documentation for "${target}" across npm, PyPI, crates.io, and Go.`,
                            `Check package name spelling or query directly via source="context7" or fetchGithubContent.`
                        )
                    }],
                    isError: true
                };
            }

            // 4. 显式指定 npm / pypi / github 仓库源
            if (reqSource === 'npm' || reqSource === 'pypi' || reqSource === 'github') {
                logTool(`queryDocs directly querying registry/repo fallback for: ${target}`);
                const fallback = await fetchPackageDocsFallback({
                    library: target,
                    version,
                    signal,
                    fetchGithub: async (url) => runtime.services.fetchGithubReadme.execute({ url }),
                    reasonHint: ''
                });
                if (fallback) {
                    metrics.recordQueryDocsAttempt(fallback.source, false);
                    const combinedWarnings = [...new Set([...fallback.warnings, ...unknownWarnings])];
                    const text = capTextResponse(formatQueryDocsMarkdown({
                        libraryId: fallback.libraryId,
                        query,
                        source: fallback.source,
                        confidence: fallback.confidence,
                        repositoryUrl: fallback.repositoryUrl,
                        readme: fallback.readme,
                        warnings: combinedWarnings
                    }));
                    if (fallback.confidence !== 'low') {
                        setDocsCache(cacheKey, { text, source: fallback.source, confidence: fallback.confidence, cachedAt: Date.now() });
                    }
                    return {
                        content: [{ type: 'text', text }],
                        source: fallback.source,
                        confidence: fallback.confidence,
                        warnings: combinedWarnings
                    } as unknown as { content: Array<{ type: 'text'; text: string }> };
                }
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to locate repository documentation for "${target}"`,
                            `Verify package name spelling or try source="auto".`
                        )
                    }],
                    isError: true
                };
            }

            // 5. auto 模式下的特定生态快速路由
            if (reqSource === 'auto') {
                if (target.startsWith('crates:') || target.startsWith('crate:')) {
                    const clean = target.replace(/^crates?:/, '').trim().split('@')[0]?.trim() || target;
                    const url = version
                        ? `https://docs.rs/${encodeURIComponent(clean)}/${encodeURIComponent(version)}`
                        : `https://docs.rs/${encodeURIComponent(clean)}`;
                    const content = await fetchViaWeb(url);
                    if (content) {
                        metrics.recordQueryDocsAttempt('docs.rs', false);
                        const text = capTextResponse(formatQueryDocsMarkdown({
                            libraryId: clean,
                            query,
                            source: 'docs.rs',
                            confidence: 'high',
                            documentationUrl: url,
                            content,
                            warnings: unknownWarnings
                        }));
                        setDocsCache(cacheKey, { text, source: 'docs.rs', confidence: 'high', cachedAt: Date.now() });
                        return {
                            content: [{ type: 'text', text }],
                            source: 'docs.rs',
                            confidence: 'high',
                            warnings: unknownWarnings
                        } as unknown as { content: Array<{ type: 'text'; text: string }> };
                    }
                }

                if (target.startsWith('go:') || target.includes('golang.org/') || (target.startsWith('github.com/') && target.split('/').length >= 3)) {
                    const clean = target.replace(/^go:/, '').trim().split('@')[0]?.trim() || target;
                    const url = version
                        ? `https://pkg.go.dev/${clean}@${encodeURIComponent(version)}`
                        : `https://pkg.go.dev/${clean}`;
                    const content = await fetchViaWeb(url);
                    if (content) {
                        metrics.recordQueryDocsAttempt('pkg.go.dev', false);
                        const text = capTextResponse(formatQueryDocsMarkdown({
                            libraryId: clean,
                            query,
                            source: 'pkg.go.dev',
                            confidence: 'high',
                            documentationUrl: url,
                            content,
                            warnings: unknownWarnings
                        }));
                        setDocsCache(cacheKey, { text, source: 'pkg.go.dev', confidence: 'high', cachedAt: Date.now() });
                        return {
                            content: [{ type: 'text', text }],
                            source: 'pkg.go.dev',
                            confidence: 'high',
                            warnings: unknownWarnings
                        } as unknown as { content: Array<{ type: 'text'; text: string }> };
                    }
                }
            }

            // 6. Context7 主路径（针对 auto 与 context7）
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

            // 检查 Context7 匹配质量：若高/中置信度命中，直接返回
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

            // 7. Context7 限额、报错或低置信度时，仅在 auto 模式下尝试 official 官方文档站与 fallback
            if (reqSource === 'auto') {
                // 优先尝试 official 官方文档站直连
                try {
                    logTool(`Context7 match confidence is low or failed for "${target}". Probing official doc site...`);
                    const meta = await resolvePackageMetadata(target, { signal, version });
                    const docUrl = meta?.documentationUrl || (meta?.homepageUrl && !meta.homepageUrl.includes('github.com') && !meta.homepageUrl.includes('gitee.com') ? meta.homepageUrl : null);
                    if (docUrl) {
                        const content = await fetchViaWeb(docUrl);
                        if (content) {
                            logTool(`Official doc site fetch succeeded: ${docUrl}`);
                            metrics.recordQueryDocsAttempt('official', true);
                            const fallbackNotice = getContext7FallbackNotice({
                                context7Error,
                                context7Result,
                                target,
                                destination: `official documentation site (${docUrl})`
                            });
                            const combinedWarnings = [fallbackNotice, ...unknownWarnings];
                            const text = capTextResponse(formatQueryDocsMarkdown({
                                libraryId: meta?.libraryId || target,
                                query,
                                source: 'official',
                                confidence: 'medium',
                                documentationUrl: docUrl,
                                repositoryUrl: meta?.repositoryUrl || undefined,
                                content,
                                warnings: combinedWarnings
                            }));
                            setDocsCache(cacheKey, { text, source: 'official', confidence: 'medium', cachedAt: Date.now() });
                            return {
                                content: [{ type: 'text', text }],
                                source: 'official',
                                confidence: 'medium',
                                warnings: combinedWarnings
                            } as unknown as { content: Array<{ type: 'text'; text: string }> };
                        }
                    }
                } catch (offErr) {
                    logSafeError('Official docs probing failed', offErr);
                }

                // 启动包管理器 README 兜底
                logTool(`Attempting npm/PyPI/crates/Go fallback for "${target}"...`);
                let fallbackResult: PackageDocsFallbackResult | null = null;
                const fallbackReason = context7Error
                    ? (isContext7QuotaExhaustedError(context7Error)
                        ? 'Context7 monthly quota exhausted (HTTP 402). Configure CONTEXT7_API_KEY in ~/.my-websearch/config.json to restore Context7 access.'
                        : `Context7 service temporarily unavailable (${context7Error instanceof Error ? context7Error.message : String(context7Error)}).`)
                    : (context7Result && context7Result.matchConfidence === 'low'
                        ? `Library "${target}" was not indexed by Context7 or match confidence was low${context7Result.libraryId ? ` (closest candidate: "${context7Result.libraryId}")` : ''}.`
                        : 'Context7 match confidence was low or library was not found in Context7.');

                try {
                    fallbackResult = await fetchPackageDocsFallback({
                        library: target,
                        version,
                        signal,
                        fetchGithub: async (url) => runtime.services.fetchGithubReadme.execute({ url }),
                        reasonHint: fallbackReason
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

                // 如果兜底也未找到，但在非 strict 模式下有 Context7 低置信度候选
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
            }

            // 最终报错处理
            const finalErr = context7Error || new Error(`No documentation found for library "${target}" via requested source "${reqSource}".`);
            logSafeError('Failed to fetch docs', finalErr);
            return {
                content: [{
                    type: 'text',
                    text: withErrorHint(
                        `Failed to fetch docs: ${finalErr instanceof Error ? finalErr.message : 'Unknown error'}`,
                        isContext7QuotaExhaustedError(finalErr)
                            ? CONTEXT7_QUOTA_HINT
                            : '可检查库名拼写（如 "next.js" 或 "/vercel/next.js"），或指定 source="official" / source="docs.rs" / source="pkg.go.dev" 重试。'
                    )
                }],
                isError: true
            };
        }
    );
}
