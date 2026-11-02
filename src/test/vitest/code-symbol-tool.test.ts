import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * codeSymbol 的「输出契约」测试：用模块 mock 拦住 findCodeSymbol，只验证
 * handler 的渲染格式、未知参数告警、错误封套与响应封顶，不依赖任何网络或 GITHUB_TOKEN。
 */

const findCodeSymbolMock = vi.hoisted(() => vi.fn());

vi.mock('../../core/codeIntel/remoteCodeIntel.js', () => ({
    findCodeSymbol: findCodeSymbolMock
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCodeSymbolTool } from '../../tools/handlers/codeSymbolTool.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';
import { AppError } from '../../core/errors.js';

interface ToolResponse {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    warnings?: string[];
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

function getHandler(): ToolHandler {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerCodeSymbolTool(server, createMyWebSearchRuntime());
    const registered = (server as unknown as {
        _registeredTools: Record<string, { handler?: ToolHandler }>;
    })._registeredTools;
    const handler = registered['codeSymbol']?.handler;
    expect(handler).toBeDefined();
    return handler!;
}

function textOf(response: ToolResponse): string {
    return response.content.map((item) => item.text).join('\n');
}

function makeResult(overrides: Record<string, unknown> = {}) {
    return {
        repo: 'fastapi/fastapi',
        symbol: 'Depends',
        ref: 'master',
        definitions: [],
        references: [],
        callSites: [],
        filesScanned: 0,
        warnings: [],
        ...overrides
    };
}

beforeEach(() => {
    findCodeSymbolMock.mockReset();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('codeSymbol result rendering', () => {
    it('renders definitions with type information, references and call sites', async () => {
        findCodeSymbolMock.mockResolvedValue(makeResult({
            filesScanned: 3,
            definitions: [
                {
                    path: 'fastapi/params.py',
                    language: 'python',
                    kind: 'class',
                    signature: 'class Depends:',
                    startLine: 12,
                    endLine: 40,
                    code: 'class Depends:\n    ...',
                    typeInfo: {
                        returnType: 'Promise<void>',
                        parameters: ['dependency: Callable', 'use_cache?: bool'],
                        type: 'Depends'
                    }
                },
                {
                    path: 'src/index.ts',
                    language: 'typescript',
                    kind: 'function',
                    signature: 'export function Depends()',
                    startLine: 4,
                    endLine: 6,
                    code: 'export function Depends() {}',
                    via: 'src/barrel.ts',
                    truncated: true
                }
            ],
            references: [{ path: 'src/app.ts', lines: [3, 4] }],
            callSites: [{ path: 'src/main.ts', line: 10, caller: 'bootstrap', snippet: 'Depends()' }]
        }));

        const text = textOf(await getHandler()({ repo: 'fastapi/fastapi', symbol: 'Depends' }));

        expect(text).toContain('# Symbol: Depends');
        expect(text).toContain('> Repository: fastapi/fastapi | Ref: master | Files scanned: 3');
        expect(text).toContain('## Definitions (2)');
        expect(text).toContain('### `fastapi/params.py:12` (class)');
        expect(text).toContain('> Return: `Promise<void>`');
        expect(text).toContain('> Params: `dependency: Callable`, `use_cache?: bool`');
        expect(text).toContain('> Type: `Depends`');
        expect(text).toContain('```python');
        expect(text).toContain('### `src/index.ts:4` (function) — via `src/barrel.ts`');
        expect(text).toContain('## References');
        expect(text).toContain('- `src/app.ts`: lines 3, 4');
        expect(text).toContain('## Call sites (syntactic)');
        expect(text).toContain('- `src/main.ts:10` in `bootstrap`: `Depends()`');
    });

    it('states the empty result explicitly and shows cached/partial markers only when set', async () => {
        findCodeSymbolMock.mockResolvedValue(makeResult({
            warnings: ['No declaration matched. Try a different kind or pass the exact symbol name.'],
            cached: true,
            partial: true
        }));

        const text = textOf(await getHandler()({ repo: 'fastapi/fastapi', symbol: 'Missing' }));

        expect(text).toContain('No declaration was found in the matching files.');
        expect(text).not.toContain('## Definitions');
        expect(text).toContain('> Cached: yes');
        expect(text).toContain('> Partial: yes (codeSymbol budget reached)');
        expect(text).toContain('## Warnings');
        expect(text).toContain('No declaration matched');
    });

    it('omits optional markers and warning sections for a plain successful result', async () => {
        findCodeSymbolMock.mockResolvedValue(makeResult());

        const text = textOf(await getHandler()({ repo: 'fastapi/fastapi', symbol: 'Depends' }));

        expect(text).not.toContain('> Cached: yes');
        expect(text).not.toContain('> Partial: yes');
        expect(text).not.toContain('## Warnings');
    });

    it('forwards every documented argument to the core lookup', async () => {
        findCodeSymbolMock.mockResolvedValue(makeResult());

        await getHandler()({
            repo: 'fastapi/fastapi',
            symbol: 'Depends',
            kind: 'function',
            ref: 'v1.0.0',
            maxResults: 3
        });

        expect(findCodeSymbolMock).toHaveBeenCalledWith({
            repo: 'fastapi/fastapi',
            symbol: 'Depends',
            kind: 'function',
            ref: 'v1.0.0',
            maxResults: 3
        });
    });
});

describe('codeSymbol warnings and error envelopes', () => {
    it('turns unknown parameters into warnings in both the text and the response payload', async () => {
        findCodeSymbolMock.mockResolvedValue(makeResult());

        const response = await getHandler()({
            repo: 'fastapi/fastapi',
            symbol: 'Depends',
            language: 'python',
            timeout: 5
        });
        const text = textOf(response);

        expect(response.warnings).toHaveLength(1);
        expect(response.warnings?.[0]).toContain("Unknown parameter(s) ignored: 'language', 'timeout'");
        expect(text).toContain('## Warnings');
        expect(text).toContain("Unknown parameter(s) ignored: 'language', 'timeout'");
    });

    it('returns an isError envelope carrying the AppError message and hint', async () => {
        findCodeSymbolMock.mockRejectedValue(new AppError({
            code: 'engine_error',
            retryable: false,
            engine: 'github',
            message: 'GitHub code search returned HTTP 401.',
            hint: '检查 GITHUB_TOKEN 是否有效，以及是否有 code search 权限。'
        }));

        const response = await getHandler()({ repo: 'fastapi/fastapi', symbol: 'Depends' });
        const text = textOf(response);

        expect(response.isError).toBe(true);
        expect(text).toContain('Failed to find code symbol: GitHub code search returned HTTP 401.');
        expect(text).toContain('Hint: 检查 GITHUB_TOKEN 是否有效，以及是否有 code search 权限。');
        expect(response.warnings).toEqual([]);
    });

    it('falls back to the generic repo/symbol hint for non-AppError failures', async () => {
        findCodeSymbolMock.mockRejectedValue(new Error('socket hang up'));

        const response = await getHandler()({ repo: 'fastapi/fastapi', symbol: 'Depends' });
        const text = textOf(response);

        expect(response.isError).toBe(true);
        expect(text).toContain('Failed to find code symbol: socket hang up');
        expect(text).toContain('Hint: 确认 repo 为 owner/repo');
    });

    it('caps an oversized rendered response and keeps the truncation marker', async () => {
        const hugeCode = Array.from({ length: 400 }, (_, index) => `    const value${index} = ${index};`).join('\n');
        findCodeSymbolMock.mockResolvedValue(makeResult({
            definitions: [{
                path: 'src/huge.ts',
                language: 'typescript',
                kind: 'function',
                signature: 'function Depends()',
                startLine: 1,
                endLine: 402,
                code: hugeCode
            }]
        }));

        const uncapped = textOf(await getHandler()({ repo: 'fastapi/fastapi', symbol: 'Depends' }));
        expect(uncapped.length).toBeGreaterThan(5000);

        vi.stubEnv('OPEN_WEBSEARCH_RESPONSE_CAP_BYTES', '600');
        const capped = textOf(await getHandler()({ repo: 'fastapi/fastapi', symbol: 'Depends' }));

        expect(capped.length).toBeLessThan(uncapped.length);
        expect(Buffer.byteLength(capped, 'utf8')).toBeLessThan(1000);
        expect(capped).toContain('[truncated by response cap (600 bytes)');
        expect(capped.startsWith('# Symbol: Depends')).toBe(true);
    });
});
