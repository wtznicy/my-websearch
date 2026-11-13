import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFetchWebTool } from '../../tools/handlers/fetchWebTool.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';

describe('fetchWebContent tool schema and handler invocation', () => {
    function setupToolTest() {
        let capturedTool: { name: string; definition: any; handler: Function } | null = null;
        const server = {
            registerTool: (name: string, definition: any, handler: Function) => {
                capturedTool = { name, definition, handler };
            }
        } as unknown as McpServer;

        const mockExecute = vi.fn().mockImplementation(async (options) => ({
            url: options.url,
            finalUrl: options.url,
            contentType: 'text/html',
            title: `Title for ${options.url}`,
            content: `Extracted content for ${options.url}`,
            totalLength: 100,
            startIndex: options.startIndex ?? 0,
            truncated: false
        }));

        const runtime = createMyWebSearchRuntime();
        runtime.services.fetchWeb.execute = mockExecute;

        registerFetchWebTool(server, runtime);

        return { tool: capturedTool!, mockExecute };
    }

    it('registers fetchWebContent with outline, BM25 focus and batch URLs in description', () => {
        const { tool } = setupToolTest();
        expect(tool.name).toBe('fetchWebContent');
        expect(tool.definition.description).toContain('outline mode & sectionId');
        expect(tool.definition.description).toContain('BM25 focus');
        expect(tool.definition.description).toContain('batch URLs');
    });

    it('handles single url as string correctly', async () => {
        const { tool, mockExecute } = setupToolTest();
        const res = await tool.handler({ url: 'https://example.com/single' }, {});

        expect(mockExecute).toHaveBeenCalledTimes(1);
        expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://example.com/single'
        }));
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain('Title for https://example.com/single');
    });

    it('handles array of urls in url parameter as batch execution', async () => {
        const { tool, mockExecute } = setupToolTest();
        const res = await tool.handler({
            url: ['https://example.com/p1', 'https://example.com/p2']
        }, {});

        expect(mockExecute).toHaveBeenCalledTimes(2);
        expect(res.isError).toBeFalsy();
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.urls).toEqual(['https://example.com/p1', 'https://example.com/p2']);
        expect(parsed.results.length).toBe(2);
    });

    it('maintains backwards compatibility for urls parameter', async () => {
        const { tool, mockExecute } = setupToolTest();
        const res = await tool.handler({
            urls: ['https://example.com/legacy1', 'https://example.com/legacy2']
        }, {});

        expect(mockExecute).toHaveBeenCalledTimes(2);
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.urls).toEqual(['https://example.com/legacy1', 'https://example.com/legacy2']);
    });

    it('maps format=raw to raw=true execution', async () => {
        const { tool, mockExecute } = setupToolTest();
        await tool.handler({
            url: 'https://example.com/page',
            format: 'raw'
        }, {});

        expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://example.com/page',
            raw: true,
            format: undefined
        }));
    });

    it('passes outline mode and sectionId to service', async () => {
        const { tool, mockExecute } = setupToolTest();
        await tool.handler({
            url: 'https://example.com/long-doc',
            mode: 'outline',
            sectionId: 'getting-started'
        }, {});

        expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://example.com/long-doc',
            mode: 'outline',
            sectionId: 'getting-started'
        }));
    });

    it('passes focus keyword with default bm25 focusMode', async () => {
        const { tool, mockExecute } = setupToolTest();
        await tool.handler({
            url: 'https://example.com/doc',
            focus: 'authentication'
        }, {});

        expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://example.com/doc',
            focus: 'authentication'
        }));
    });

    it('returns error when neither url nor urls is provided', async () => {
        const { tool, mockExecute } = setupToolTest();
        const res = await tool.handler({}, {});

        expect(mockExecute).not.toHaveBeenCalled();
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('Provide a valid "url"');
    });
});
