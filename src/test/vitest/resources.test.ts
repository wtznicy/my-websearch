import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerResources } from '../../tools/resources.js';

describe('MCP cache resources', () => {
    it('registers page and docs index plus read templates', () => {
        const names: string[] = [];
        const templates: string[] = [];
        const server = {
            registerResource: (name: string, uriOrTemplate: unknown) => {
                names.push(name);
                if (uriOrTemplate instanceof ResourceTemplate) {
                    templates.push(uriOrTemplate.uriTemplate.toString());
                }
            }
        } as unknown as McpServer;

        registerResources(server);
        expect(names).toEqual([
            'websearch-page-cache',
            'websearch-page',
            'websearch-docs-cache',
            'websearch-docs'
        ]);
        expect(templates).toEqual([
            'websearch://cache/pages/{id}',
            'websearch://cache/docs/{id}'
        ]);
    });

    it('returns an entries array for the empty page-cache index', async () => {
        const callbacks: Array<(uri: URL) => Promise<{ contents: Array<{ text: string }> }>> = [];
        const server = {
            registerResource: (_name: string, uri: unknown, _config: unknown, callback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }>) => {
                if (typeof uri === 'string') callbacks.push(callback);
            }
        } as unknown as McpServer;

        registerResources(server);
        const result = await callbacks[0]!(new URL('websearch://cache/pages'));
        const payload = JSON.parse(result.contents[0]!.text) as { entries: unknown[] };
        expect(Array.isArray(payload.entries)).toBe(true);
    });
});
