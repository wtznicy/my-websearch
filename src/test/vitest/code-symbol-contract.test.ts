import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCodeSymbolTool } from '../../tools/handlers/codeSymbolTool.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';
import { findCodeSymbol } from '../../core/codeIntel/remoteCodeIntel.js';

/**
 * codeSymbol 的「对外契约」测试：只覆盖注册面、入参 schema 与不触网即可判定的校验分支。
 * 成功路径（GitHub Code Search + raw 文件）需要真实网络与 GITHUB_TOKEN，放在 test:live。
 */

interface RegisteredTool {
    description?: string;
    annotations?: Record<string, unknown>;
    inputSchema?: {
        safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown> };
    };
}

function registerCodeSymbol(): RegisteredTool {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerCodeSymbolTool(server, createMyWebSearchRuntime());
    const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
    const tool = registered['codeSymbol'];
    expect(tool, 'codeSymbol must be registered under its default name').toBeDefined();
    return tool;
}

function schemaOf(tool: RegisteredTool) {
    expect(tool.inputSchema).toBeDefined();
    return tool.inputSchema!;
}

const VALID_ARGS = { repo: 'fastapi/fastapi', symbol: 'Depends' };

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('codeSymbol tool contract', () => {
    it('registers with read-only annotations and a GITHUB_TOKEN hint inside the 250-char budget', () => {
        const tool = registerCodeSymbol();
        const description = tool.description ?? '';

        expect(description.length).toBeLessThanOrEqual(250);
        expect(description).toContain('GITHUB_TOKEN');
        expect(description).toContain('Example:');
        expect(description).toContain('repo=');
        expect(tool.annotations).toEqual({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        });
    });

    it('accepts the documented repo forms and rejects empty or oversized identifiers', () => {
        const schema = schemaOf(registerCodeSymbol());

        expect(schema.safeParse(VALID_ARGS).success).toBe(true);
        expect(schema.safeParse({ repo: 'https://github.com/fastapi/fastapi', symbol: 'Depends' }).success).toBe(true);
        expect(schema.safeParse({ repo: 'git@github.com:fastapi/fastapi.git', symbol: 'Depends' }).success).toBe(true);

        expect(schema.safeParse({ symbol: 'Depends' }).success, 'repo is required').toBe(false);
        expect(schema.safeParse({ repo: 'fastapi/fastapi' }).success, 'symbol is required').toBe(false);
        expect(schema.safeParse({ repo: '', symbol: 'Depends' }).success).toBe(false);
        expect(schema.safeParse({ repo: 'fastapi/fastapi', symbol: '' }).success).toBe(false);
        expect(schema.safeParse({ repo: 'r'.repeat(501), symbol: 'Depends' }).success).toBe(false);
        expect(schema.safeParse({ repo: 'fastapi/fastapi', symbol: 's'.repeat(201) }).success).toBe(false);
    });

    it('coerces numeric maxResults strings and enforces the documented 1-10 range', () => {
        const schema = schemaOf(registerCodeSymbol());

        const parsed = schema.safeParse({ ...VALID_ARGS, maxResults: '7' });
        expect(parsed.success).toBe(true);
        expect(parsed.data?.maxResults).toBe(7);

        // 空字符串沿用其它工具的约定：视为「未传」，走默认 5 而不是报错
        const empty = schema.safeParse({ ...VALID_ARGS, maxResults: '' });
        expect(empty.success).toBe(true);
        expect(empty.data?.maxResults).toBeUndefined();

        for (const invalid of [0, 11, '0', '11', 'abc', 1.5]) {
            expect(schema.safeParse({ ...VALID_ARGS, maxResults: invalid }).success, `maxResults=${String(invalid)}`).toBe(false);
        }
    });

    it('restricts kind to the declared enum and passes unknown keys through to the handler', () => {
        const schema = schemaOf(registerCodeSymbol());

        for (const kind of ['class', 'function', 'interface', 'type', 'method', 'const', 'enum', 'struct', 'trait', 'namespace']) {
            expect(schema.safeParse({ ...VALID_ARGS, kind }).success, `kind=${kind}`).toBe(true);
        }
        expect(schema.safeParse({ ...VALID_ARGS, kind: 'variable' }).success).toBe(false);

        // .passthrough()：未知参数在 schema 层放行，由 handler 的 detectUnknownParameters 转成 warning
        const withUnknown = schema.safeParse({ ...VALID_ARGS, language: 'python' });
        expect(withUnknown.success).toBe(true);
        expect(withUnknown.data?.language).toBe('python');
    });

    it('honours MCP_TOOL_CODE_SYMBOL_NAME and falls back to the default on invalid names', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        vi.stubEnv('MCP_TOOL_CODE_SYMBOL_NAME', 'findSymbol');
        const renamed = new McpServer({ name: 'test', version: '1.0.0' });
        registerCodeSymbolTool(renamed, createMyWebSearchRuntime());
        const renamedTools = (renamed as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
        expect(renamedTools['findSymbol']).toBeDefined();
        expect(renamedTools['codeSymbol']).toBeUndefined();

        vi.stubEnv('MCP_TOOL_CODE_SYMBOL_NAME', 'bad name!');
        const fallback = new McpServer({ name: 'test', version: '1.0.0' });
        registerCodeSymbolTool(fallback, createMyWebSearchRuntime());
        const fallbackTools = (fallback as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
        expect(fallbackTools['codeSymbol']).toBeDefined();
        expect(warn).toHaveBeenCalled();
    });
});

describe('codeSymbol core validation (no network)', () => {
    it('rejects a repo spec that is neither owner/repo nor a github.com URL', async () => {
        vi.stubEnv('GITHUB_TOKEN', '');

        await expect(findCodeSymbol({ repo: 'not a repo', symbol: 'Depends' }))
            .rejects.toMatchObject({ code: 'invalid_arguments', retryable: false });
        await expect(findCodeSymbol({ repo: 'not a repo', symbol: 'Depends' }))
            .rejects.toThrow('Invalid GitHub repository');
    });

    it('rejects symbols that are not a single identifier before spending the GitHub quota', async () => {
        vi.stubEnv('GITHUB_TOKEN', '');

        for (const symbol of ['foo bar', 'foo(bar)', 'foo/bar', 'foo:bar', '']) {
            await expect(findCodeSymbol({ repo: 'fastapi/fastapi', symbol }), `symbol=${JSON.stringify(symbol)}`)
                .rejects.toMatchObject({ code: 'invalid_arguments' });
        }
    });

    it('requires GITHUB_TOKEN and points at the keyless fetchGithubContent fallback', async () => {
        vi.stubEnv('GITHUB_TOKEN', '   ');

        const error = await findCodeSymbol({ repo: 'fastapi/fastapi', symbol: 'Depends' }).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ code: 'missing_api_key', retryable: false, engine: 'github' });
        expect((error as Error).message).toContain('requires GITHUB_TOKEN');
        expect((error as { hint?: string }).hint).toContain('fetchGithubContent');
    });
});
