import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueryDocsTool, formatQueryDocsMarkdown } from '../../tools/handlers/queryDocsTool.js';
import { docsCacheKey } from '../../core/docs/docsCache.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';

describe('queryDocs Multi-Source Engine & Provider Suite', () => {
    describe('formatQueryDocsMarkdown with multi-source capabilities', () => {
        it('renders markdown with official documentationUrl and direct content', () => {
            const formatted = formatQueryDocsMarkdown({
                libraryId: 'fastapi',
                source: 'official',
                confidence: 'high',
                documentationUrl: 'https://fastapi.tiangolo.com',
                repositoryUrl: 'https://github.com/tiangolo/fastapi',
                content: '## FastAPI Framework\n\nFastAPI is a modern, fast web framework for building APIs with Python.'
            });

            expect(formatted).toContain('# Docs: fastapi');
            expect(formatted).toContain('> Source: official | Confidence: high');
            expect(formatted).toContain('> Documentation: https://fastapi.tiangolo.com');
            expect(formatted).toContain('> Repository: https://github.com/tiangolo/fastapi');
            expect(formatted).toContain('FastAPI Framework');
            expect(formatted).toContain('FastAPI is a modern, fast web framework');
        });

        it('renders docs.rs and pkg.go.dev sources correctly', () => {
            const rustDocs = formatQueryDocsMarkdown({
                libraryId: 'tokio',
                source: 'docs.rs',
                confidence: 'high',
                documentationUrl: 'https://docs.rs/tokio',
                content: '# Crate tokio\n\nA runtime for writing reliable, asynchronous applications.'
            });
            expect(rustDocs).toContain('> Source: docs.rs | Confidence: high');
            expect(rustDocs).toContain('> Documentation: https://docs.rs/tokio');

            const goDocs = formatQueryDocsMarkdown({
                libraryId: 'github.com/gin-gonic/gin',
                source: 'pkg.go.dev',
                confidence: 'high',
                documentationUrl: 'https://pkg.go.dev/github.com/gin-gonic/gin',
                content: '# package gin\n\nPackage gin implements a HTTP web framework.'
            });
            expect(goDocs).toContain('> Source: pkg.go.dev | Confidence: high');
            expect(goDocs).toContain('> Documentation: https://pkg.go.dev/github.com/gin-gonic/gin');
        });
    });

    describe('docsCacheKey with source parameter', () => {
        it('isolates cache keys across different sources and defaults auto to base key', () => {
            const defaultKey = docsCacheKey({ library: 'fastapi', query: 'auth', limit: 5 });
            const autoKey = docsCacheKey({ library: 'fastapi', query: 'auth', limit: 5, source: 'auto' });
            const docsRsKey = docsCacheKey({ library: 'fastapi', query: 'auth', limit: 5, source: 'docs.rs' });
            const officialKey = docsCacheKey({ library: 'fastapi', query: 'auth', limit: 5, source: 'official' });

            expect(defaultKey).toBe(autoKey);
            expect(docsRsKey).toContain('|docs.rs');
            expect(officialKey).toContain('|official');
            expect(docsRsKey).not.toBe(officialKey);
        });
    });

    describe('Tool execution with source parameter dispatch', () => {
        it('dispatches to docs.rs directly when source="docs.rs"', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '## Tokio Runtime Documentation\n\nAn event-driven, non-blocking I/O platform.',
                title: 'tokio - Rust'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            registerQueryDocsTool(server, runtime);

            const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;
            expect(toolHandler).toBeDefined();

            const result = await toolHandler({
                library: 'tokio',
                source: 'docs.rs',
                cache: 'reload'
            });

            expect(mockFetchWeb).toHaveBeenCalledWith(expect.objectContaining({
                url: 'https://docs.rs/tokio',
                format: 'markdown'
            }));
            expect(result.content[0].text).toContain('> Source: docs.rs');
            expect(result.content[0].text).toContain('Tokio Runtime Documentation');
        });

        it('dispatches to pkg.go.dev directly when source="pkg.go.dev"', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '## Package gin documentation\n\nHTTP web framework with martini-like API.',
                title: 'gin - Go'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            registerQueryDocsTool(server, runtime);

            const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;

            const result = await toolHandler({
                library: 'github.com/gin-gonic/gin',
                source: 'pkg.go.dev',
                cache: 'reload'
            });

            expect(mockFetchWeb).toHaveBeenCalledWith(expect.objectContaining({
                url: 'https://pkg.go.dev/github.com/gin-gonic/gin',
                format: 'markdown'
            }));
            expect(result.content[0].text).toContain('> Source: pkg.go.dev');
            expect(result.content[0].text).toContain('Package gin documentation');
        });

        it('auto-routes crates: prefix to docs.rs in auto mode', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '## Serde Crate Documentation\n\nA generic serialization/deserialization framework.',
                title: 'serde - Rust'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            registerQueryDocsTool(server, runtime);

            const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;

            const result = await toolHandler({
                library: 'crates:serde',
                source: 'auto',
                cache: 'reload'
            });

            expect(mockFetchWeb).toHaveBeenCalledWith(expect.objectContaining({
                url: 'https://docs.rs/serde'
            }));
            expect(result.content[0].text).toContain('> Source: docs.rs');
            expect(result.content[0].text).toContain('Serde Crate Documentation');
        });
    });
});
