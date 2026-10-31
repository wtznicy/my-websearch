import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findCodeSymbol, type CodeSymbolKind, type CodeSymbolResult } from '../../core/codeIntel/remoteCodeIntel.js';
import { isAppError } from '../../core/errors.js';
import { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import {
    capTextResponse,
    getToolName,
    logSafeError,
    logTool,
    TOOL_ANNOTATION_HINTS,
    withErrorHint
} from '../toolShared.js';
import { detectUnknownParameters } from '../../utils/toolValidation.js';

function formatCodeSymbol(result: CodeSymbolResult): string {
    const lines: string[] = [
        `# Symbol: ${result.symbol}`,
        `> Repository: ${result.repo} | Ref: ${result.ref} | Files scanned: ${result.filesScanned}`
    ];

    if (result.definitions.length === 0) {
        lines.push('', 'No declaration was found in the matching files.');
    } else {
        lines.push('', `## Definitions (${result.definitions.length})`);
        for (const definition of result.definitions) {
            lines.push(
                '',
                `### \`${definition.path}:${definition.startLine}\` (${definition.kind})${definition.via ? ` — via \`${definition.via}\`` : ''}`,
                '',
                '```' + definition.language,
                definition.code,
                '```'
            );
        }
    }

    if (result.references.length > 0) {
        lines.push('', '## References');
        for (const reference of result.references) {
            lines.push(`- \`${reference.path}\`: lines ${reference.lines.join(', ')}`);
        }
    }

    if (result.callSites.length > 0) {
        lines.push('', '## Call sites (syntactic)');
        for (const site of result.callSites) {
            lines.push(`- \`${site.path}:${site.line}\`${site.caller ? ` in \`${site.caller}\`` : ''}: \`${site.snippet}\``);
        }
    }

    if (result.warnings.length > 0) {
        lines.push('', '## Warnings');
        for (const warning of result.warnings) {
            lines.push(`- ${warning}`);
        }
    }

    return lines.join('\n');
}

export function registerCodeSymbolTool(server: McpServer, _runtime: MyWebSearchRuntime): void {
    const toolName = getToolName('MCP_TOOL_CODE_SYMBOL_NAME', 'codeSymbol');

    server.registerTool(
        toolName,
        {
            description: 'Find a symbol declaration and references in a remote GitHub repo. Uses GitHub code search + raw files; returns signature, code block, and reference lines. Requires GITHUB_TOKEN. Example: repo="fastapi/fastapi", symbol="Depends".',
            inputSchema: z.object({
                repo: z.string().min(1).max(500).describe('GitHub repository: owner/repo or https://github.com/owner/repo'),
                symbol: z.string().min(1).max(200).describe('Exact symbol name (class/function/interface/type/const)'),
                kind: z.enum(['class', 'function', 'interface', 'type', 'method', 'const', 'enum', 'struct', 'trait']).optional()
                    .describe('Optional declaration kind filter'),
                ref: z.string().min(1).max(200).optional().describe('Optional branch/tag/commit for raw file fetch'),
                maxResults: z.preprocess((value) => (value === undefined || value === '' ? undefined : Number(value)), z.number().int().min(1).max(10).optional())
                    .describe('Max definitions to return (1-10, default 5)')
            }).passthrough(),
            annotations: TOOL_ANNOTATION_HINTS
        },
        async (rawArgs) => {
            const { repo, symbol, kind, ref, maxResults } = rawArgs as {
                repo: string;
                symbol: string;
                kind?: CodeSymbolKind;
                ref?: string;
                maxResults?: number;
            } & Record<string, unknown>;
            const unknownWarnings = detectUnknownParameters(rawArgs as Record<string, unknown>, ['repo', 'symbol', 'kind', 'ref', 'maxResults']);
            try {
                logTool(`Finding code symbol ${symbol} in ${repo}`);
                const result = await findCodeSymbol({ repo, symbol, kind, ref, maxResults });
                const warnings = [...result.warnings, ...unknownWarnings];
                const formatted = formatCodeSymbol({ ...result, warnings });
                return {
                    content: [{ type: 'text', text: capTextResponse(formatted) }],
                    warnings
                } as unknown as { content: Array<{ type: 'text'; text: string }> };
            } catch (error) {
                logSafeError('Failed to find code symbol', error);
                return {
                    content: [{
                        type: 'text',
                        text: withErrorHint(
                            `Failed to find code symbol: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            isAppError(error) && error.hint
                                ? error.hint
                                : '确认 repo 为 owner/repo，symbol 为精确标识符，并配置有 code search 权限的 GITHUB_TOKEN。'
                        )
                    }],
                    isError: true,
                    warnings: unknownWarnings
                };
            }
        }
    );
}
