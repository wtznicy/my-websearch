import { describe, it, expect, beforeEach, vi } from 'vitest';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import axios from 'axios';
import {
    searchGithubSymbol,
    formatSymbolSearchResult,
    __resetGithubSymbolCacheForTests,
    GithubSymbolSearchResult
} from '../../engines/github/githubSymbolSearch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFetchGithubTool } from '../../tools/handlers/fetchGithubTool.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';

/**
 * 辅助函数：构造包含指定文件列表的 tar.gz 流（用于确定性测试）
 */
function createMockTarGzStream(files: Array<{ name: string; content: string }>): Readable {
    const blocks: Buffer[] = [];

    for (const file of files) {
        const header = Buffer.alloc(512);
        // Prefix with mock-HEAD/
        const fullPath = `mock-repo-HEAD/${file.name}`;
        header.write(fullPath.slice(0, 100), 0, 100, 'utf8');

        // File mode
        header.write('0000644\0', 100, 8, 'utf8');
        // File size in octal
        const contentBuf = Buffer.from(file.content, 'utf8');
        const sizeStr = contentBuf.length.toString(8).padStart(11, '0') + ' ';
        header.write(sizeStr, 124, 12, 'utf8');
        // Checksum placeholder
        header.write('        ', 148, 8, 'utf8');
        // Typeflag: '0' for normal file
        header[156] = 48; // '0'
        // Magic
        header.write('ustar\0', 257, 6, 'utf8');

        // Calculate simple checksum
        let sum = 0;
        for (let i = 0; i < 512; i++) {
            sum += header[i]!;
        }
        const chkStr = sum.toString(8).padStart(6, '0') + '\0 ';
        header.write(chkStr, 148, 8, 'utf8');

        blocks.push(header);
        blocks.push(contentBuf);

        // Pad file content to 512-byte boundary
        const remainder = contentBuf.length % 512;
        if (remainder !== 0) {
            blocks.push(Buffer.alloc(512 - remainder));
        }
    }

    // Tar EOF: two 512-byte zero blocks
    blocks.push(Buffer.alloc(1024));

    const tarBuffer = Buffer.concat(blocks);
    const gzBuffer = zlib.gzipSync(tarBuffer);

    return Readable.from(gzBuffer);
}

describe('GitHub Symbol Search Engine', () => {
    beforeEach(() => {
        __resetGithubSymbolCacheForTests();
        vi.restoreAllMocks();
    });

    it('successfully extracts definitions across Go, TypeScript, Python and Rust', async () => {
        const mockFiles = [
            {
                name: 'routergroup.go',
                content: [
                    'package gin',
                    '',
                    '// Use adds middleware to the group',
                    'func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes {',
                    '    group.Handlers = append(group.Handlers, middleware...)',
                    '    return group.returnObj()',
                    '}'
                ].join('\n')
            },
            {
                name: 'gin.go',
                content: [
                    'package gin',
                    '',
                    '// Use attaches global middleware',
                    'func (engine *Engine) Use(middleware ...HandlerFunc) IRoutes {',
                    '    engine.RouterGroup.Use(middleware...)',
                    '    return engine',
                    '}'
                ].join('\n')
            },
            {
                name: 'other.go',
                content: [
                    'package gin',
                    '// Reference comment: calling Use here',
                    'func Setup() {',
                    '    router.Use(Logger())',
                    '}'
                ].join('\n')
            }
        ];

        vi.spyOn(axios, 'get').mockResolvedValueOnce({
            status: 200,
            data: createMockTarGzStream(mockFiles),
            headers: {}
        });

        const result = await searchGithubSymbol({
            urlOrRepo: 'gin-gonic/gin',
            symbol: 'Use',
            ref: 'master'
        });

        expect(result.owner).toBe('gin-gonic');
        expect(result.repo).toBe('gin');
        expect(result.symbol).toBe('Use');
        expect(result.mode).toBe('syntactic');
        expect(result.definitions.length).toBe(2);

        const defFiles = result.definitions.map((d) => d.file);
        expect(defFiles).toContain('routergroup.go');
        expect(defFiles).toContain('gin.go');
        expect(result.definitions[0]?.kind).toBe('function');
        expect(result.definitions[0]?.snippet).toContain('Use');

        // Check reference detected
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        const refFiles = result.references.map((r) => r.file);
        expect(refFiles).toContain('other.go');
        const otherRef = result.references.find((r) => r.file === 'other.go');
        expect(otherRef?.snippet).toContain('router.Use(Logger())');
    });

    it('ignores comments and avoids false-positive definitions', async () => {
        const mockFiles = [
            {
                name: 'test.py',
                content: [
                    '# def Calculate(x): this is a comment',
                    '"""',
                    'def Calculate(y): multiline doc',
                    '"""',
                    'def Calculate(a, b):',
                    '    return a + b'
                ].join('\n')
            }
        ];

        vi.spyOn(axios, 'get').mockResolvedValueOnce({
            status: 200,
            data: createMockTarGzStream(mockFiles),
            headers: {}
        });

        const result = await searchGithubSymbol({
            urlOrRepo: 'myorg/myrepo',
            symbol: 'Calculate'
        });

        expect(result.definitions.length).toBe(1);
        expect(result.definitions[0]?.line).toBe(5);
        expect(result.definitions[0]?.kind).toBe('function');
    });

    it('safely escapes special characters in symbol name (no Invalid RegExp error)', async () => {
        const mockFiles = [
            {
                name: 'index.ts',
                content: [
                    'export function map(fn: any) { return fn; }'
                ].join('\n')
            }
        ];

        vi.spyOn(axios, 'get').mockResolvedValueOnce({
            status: 200,
            data: createMockTarGzStream(mockFiles),
            headers: {}
        });

        // 带有括号和正则特殊字符
        const result = await searchGithubSymbol({
            urlOrRepo: 'test/repo',
            symbol: 'map('
        });

        // 不应抛出 Invalid regular expression 异常
        expect(result.symbol).toBe('map(');
    });

    it('formats results into clean Markdown with code blocks and metadata', () => {
        const mockResult: GithubSymbolSearchResult = {
            owner: 'gin-gonic',
            repo: 'gin',
            ref: 'HEAD',
            symbol: 'Use',
            mode: 'syntactic',
            scannedFiles: 59,
            totalFiles: 130,
            truncated: false,
            definitions: [
                {
                    kind: 'function',
                    file: 'routergroup.go',
                    line: 89,
                    snippet: 'func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes {\n    return group\n}',
                    isDefinition: true
                }
            ],
            references: [
                {
                    kind: 'reference',
                    file: 'gins.go',
                    line: 129,
                    snippet: 'func Use(middlewares ...gin.HandlerFunc) gin.IRoutes {',
                    isDefinition: false
                }
            ],
            warnings: []
        };

        const md = formatSymbolSearchResult(mockResult);
        expect(md).toContain('# Code Symbol Search: `Use` in `gin-gonic/gin` (HEAD)');
        expect(md).toContain('Mode: **syntactic**');
        expect(md).toContain('Scanned: **59** source files');
        expect(md).toContain('### 1. `routergroup.go:89` (function)');
        expect(md).toContain('```go');
        expect(md).toContain('## References');
        expect(md).toContain('`gins.go:129`');
    });

    it('integrates seamlessly with fetchGithubContent tool when symbol is passed', async () => {
        const server = new McpServer({ name: 'test', version: '1.0.0' });
        const runtime = createMyWebSearchRuntime();
        registerFetchGithubTool(server, runtime);

        const mockFiles = [
            {
                name: 'index.ts',
                content: 'export class RouterGroup { Use() {} }'
            }
        ];

        vi.spyOn(axios, 'get').mockResolvedValueOnce({
            status: 200,
            data: createMockTarGzStream(mockFiles),
            headers: {}
        });

        const registeredTools = (server as unknown as {
            _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>
        })._registeredTools;

        const githubTool = registeredTools['fetchGithubContent'];
        expect(githubTool).toBeDefined();

        const res = await githubTool!.handler({
            url: 'gin-gonic/gin',
            symbol: 'RouterGroup'
        });

        expect(res.content[0]?.text).toContain('Code Symbol Search: `RouterGroup` in `gin-gonic/gin`');
        expect(res.content[0]?.text).toContain('`index.ts:1` (class)');
    });

    it('matches Rust, Java, and PHP definitions accurately', async () => {
        const mockFiles = [
            {
                name: 'src/lib.rs',
                content: [
                    'pub fn parse_input() {}',
                    'pub(crate) struct Config;',
                    'macro_rules! my_macro { () => {} }'
                ].join('\n')
            },
            {
                name: 'src/Main.java',
                content: [
                    'public class Application {',
                    '    public static void startApp() {}',
                    '}'
                ].join('\n')
            },
            {
                name: 'src/index.php',
                content: [
                    '<?php',
                    'class Router {',
                    '    public function dispatchRoute() {}',
                    '}'
                ].join('\n')
            }
        ];

        vi.spyOn(axios, 'get').mockResolvedValueOnce({
            status: 200,
            data: createMockTarGzStream(mockFiles),
            headers: {}
        });

        const resRust = await searchGithubSymbol({
            urlOrRepo: 'rust-lang/example',
            symbol: 'Config'
        });
        expect(resRust.definitions.length).toBe(1);
        expect(resRust.definitions[0]?.kind).toBe('struct');
        expect(resRust.definitions[0]?.file).toBe('src/lib.rs');
    });

    it('detects Rust macros wrapped in doc! { ... } (tokio select style)', async () => {
        const mockFiles = [
            {
                name: 'tokio/src/macros/select.rs',
                content: [
                    '#[cfg(not(doc))]',
                    'doc! {macro_rules! select {',
                    '    ($($t:tt)*) => { unimplemented!() };',
                    '}}'
                ].join('\n')
            }
        ];

        vi.spyOn(axios, 'get').mockResolvedValueOnce({
            status: 200,
            data: createMockTarGzStream(mockFiles),
            headers: {}
        });

        const res = await searchGithubSymbol({ urlOrRepo: 'tokio-rs/tokio', symbol: 'select' });
        expect(res.definitions.length).toBe(1);
        expect(res.definitions[0]?.kind).toBe('macro');
        expect(res.definitions[0]?.line).toBe(2);
    });

    it('caches symbol results per maxResults instead of reusing a smaller slice', async () => {
        const mockFiles = [1, 2, 3].map((n) => ({
            name: `pkg/file${n}.go`,
            content: 'package pkg\n\nfunc Use() {}\n'
        }));

        vi.spyOn(axios, 'get')
            .mockResolvedValueOnce({
                status: 200,
                data: createMockTarGzStream(mockFiles),
                headers: {}
            })
            .mockResolvedValueOnce({
                status: 200,
                data: createMockTarGzStream(mockFiles),
                headers: {}
            });

        const small = await searchGithubSymbol({ urlOrRepo: 'owner/cache-repo', symbol: 'Use', maxResults: 1 });
        expect(small.definitions.length).toBe(1);

        // 同一进程内不同 maxResults 必须重新取，而不是复用 1 条结果
        const larger = await searchGithubSymbol({ urlOrRepo: 'owner/cache-repo', symbol: 'Use', maxResults: 5 });
        expect(larger.definitions.length).toBe(3);
    });

    it('falls back to sampled search when codeload throws network error', async () => {
        // 第一次调用 codeload 报错，第二次调用 jsDelivr flat tree 成功，第三次取文件内容成功
        vi.spyOn(axios, 'get')
            .mockRejectedValueOnce(new Error('codeload connection timeout'))
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    files: [
                        { name: '/src/index.ts' },
                        { name: '/test/index.test.ts' }
                    ]
                }
            })
            .mockResolvedValueOnce({
                status: 200,
                data: 'export function FallbackSymbol() { return true; }'
            });

        const result = await searchGithubSymbol({
            urlOrRepo: 'owner/fallback-repo',
            symbol: 'FallbackSymbol'
        });

        expect(result.truncated).toBe(true);
        expect(result.definitions.length).toBe(1);
        expect(result.definitions[0]?.snippet).toContain('FallbackSymbol');
    });
});
