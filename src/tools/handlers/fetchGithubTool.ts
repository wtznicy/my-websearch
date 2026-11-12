import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateGithubRepositoryUrl } from '../../core/validation/targetValidation.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import {
    logTool,
    logSafeError,
    withErrorHint,
    capTextResponse,
    TOOL_ANNOTATION_HINTS
} from '../toolShared.js';
import { isAppError } from '../../core/errors.js';
import { detectUnknownParameters } from '../../utils/toolValidation.js';
import { parseGitHubRepoSpec } from '../../engines/github/githubSearch.js';
import { searchGithubSymbol, formatSymbolSearchResult } from '../../engines/github/githubSymbolSearch.js';

export function registerFetchGithubTool(server: McpServer, runtime: MyWebSearchRuntime): void {
    const fetchGithubToolName = 'fetchGithubContent';

    server.registerTool(
        fetchGithubToolName,
        {
            description: "Fetch GitHub/Gitee by URL: README, file (/blob/, lines), tree, issue, PR, commit, releases, or repo symbol search ('symbol'). Example: https://github.com/o/r/blob/main/src/index.ts — ref can be branch/tag/commit; not a repo clone.",
            inputSchema: z.object({
                url: z.string().min(1).max(2048).refine(
                    (url) => validateGithubRepositoryUrl(url) || parseGitHubRepoSpec(url) !== null,
                    "URL must be a valid GitHub or Gitee repository, file, directory tree, issue, or pull request URL (supports HTTPS, SSH, or owner/repo format)"
                ),
                lines: z.string().regex(/^L?\d+(?:\s*[-–]\s*L?\d+)?$/i, 'lines must look like "120-180" or "120"').optional()
                    .describe('Optional source-file line range, 1-based inclusive (e.g. "120-180"). Only valid for /blob/ URLs; URL hash #L120-L180 also works.'),
                releaseLimit: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(1).max(30).optional())
                    .describe('Optional number of releases to return for /releases URLs (1-30, default 10).'),
                symbol: z.string().min(1).max(100).optional()
                    .describe('Optional code symbol to search in the repository (e.g. "Use", "RouterGroup", "createContext"). Performs fast whole-repo syntactic search.'),
                ref: z.string().min(1).max(100).optional()
                    .describe('Optional branch, tag, or commit for symbol search (defaults to repo default branch).'),
                maxResults: z.preprocess((val) => (val === undefined || val === '' ? undefined : Number(val)), z.number().int().min(1).max(20).optional())
                    .describe('Optional max number of symbol search results to return (1-20, default 5).')
            }).passthrough(),
            annotations: TOOL_ANNOTATION_HINTS
        },
        async (rawArgs) => {
            const { url, lines, releaseLimit, symbol, ref, maxResults } = rawArgs as {
                url: string;
                lines?: string;
                releaseLimit?: number;
                symbol?: string;
                ref?: string;
                maxResults?: number;
            } & Record<string, unknown>;
            const unknownWarnings = detectUnknownParameters(rawArgs as Record<string, unknown>, [
                'url',
                'lines',
                'releaseLimit',
                'symbol',
                'ref',
                'maxResults'
            ]);

            try {
                // 分支 1：代码符号搜索模式
                if (symbol?.trim()) {
                    logTool(`Searching GitHub symbol "${symbol}" in ${url}${ref ? ` (${ref})` : ''}`);
                    const symbolResult = await searchGithubSymbol({
                        urlOrRepo: url,
                        symbol: symbol.trim(),
                        ref,
                        maxResults
                    });

                    const text = capTextResponse(formatSymbolSearchResult(symbolResult));
                    return {
                        content: [{
                            type: 'text',
                            text
                        }],
                        warnings: [...unknownWarnings, ...symbolResult.warnings]
                    } as unknown as { content: Array<{ type: 'text'; text: string }> };
                }

                // 分支 2：普通 GitHub 内容读取模式（规范化 URL）
                let targetUrl = url.trim();
                const repoSpec = parseGitHubRepoSpec(targetUrl);
                if (repoSpec && !/^(?:https?:\/\/|git@)/i.test(targetUrl)) {
                    targetUrl = `https://github.com/${repoSpec.owner}/${repoSpec.repo}`;
                }

                logTool(`Fetching GitHub content: ${targetUrl}${lines ? ` (lines ${lines})` : ''}`);
                const result = await runtime.services.fetchGithubReadme.execute({ url: targetUrl, lines, releaseLimit });

                if (result) {
                    return {
                        content: [{
                            type: 'text',
                            text: capTextResponse(result)
                        }],
                        warnings: unknownWarnings
                    } as unknown as { content: Array<{ type: 'text'; text: string }> };
                } else {
                    return {
                        content: [{
                            type: 'text',
                            text: withErrorHint(
                                'Content not found or target repository/item does not exist',
                                '读取单个文件用 /blob/<ref>/<path>；列目录用 /tree/<ref>/<path>；代码符号搜索用 symbol="xxx"；Issue 用 /issues/<n>；PR 用 /pull/<n>；提交用 /commit/<sha>；版本对比用 /compare/<base>...<head>；Release 用 /releases。行号切片用 lines="120-180" 或 URL #L120-L180。'
                            )
                        }],
                        isError: true
                    };
                }
            } catch (error) {
                logSafeError('Failed to fetch GitHub content', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to fetch GitHub content: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            isAppError(error) && error.hint
                                ? error.hint
                                : '若资源存在但抓取失败，可确认 URL 拼写，或配置 GITHUB_TOKEN 以提升 API 速率限制。'
                        )
                    }],
                    isError: true
                };
            }
        }
    );
}
