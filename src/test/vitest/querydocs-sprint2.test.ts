import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueryDocsTool } from '../../tools/handlers/queryDocsTool.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';
import {
    resolveDevDocsSlug,
    findMatchingDevDocsEntry,
    DevDocsEntry
} from '../../core/docs/devdocsProvider.js';
import {
    isLikelyMdnTarget,
    extractMdnQuery
} from '../../core/docs/mdnProvider.js';
import {
    isLikelyJavadocTarget
} from '../../core/docs/javadocProvider.js';

describe('queryDocs Sprint 2 Suite: DevDocs, MDN, Javadoc.io', () => {
    describe('devdocsProvider', () => {
        it('resolves common aliases correctly', async () => {
            expect(await resolveDevDocsSlug('postgres')).toBe('postgresql~16');
            expect(await resolveDevDocsSlug('python')).toBe('python~3.12');
            expect(await resolveDevDocsSlug('c++')).toBe('cpp');
            expect(await resolveDevDocsSlug('k8s')).toBe('kubernetes');
            expect(await resolveDevDocsSlug('devdocs:redis')).toBe('redis');
        });

        it('findMatchingDevDocsEntry matches exact, prefix and substring queries', () => {
            const entries: DevDocsEntry[] = [
                { name: 'GET', path: 'get/index', type: 'Core: String' },
                { name: 'SET', path: 'set/index', type: 'Core: String' },
                { name: 'SETNX', path: 'setnx/index', type: 'Core: String' },
                { name: 'HGET', path: 'hget/index', type: 'Core: Hash' },
                { name: 'HSET', path: 'hset/index', type: 'Core: Hash' }
            ];

            // 1. Exact match
            const res1 = findMatchingDevDocsEntry(entries, 'get');
            expect(res1.match?.name).toBe('GET');

            // 2. Prefix match
            const res2 = findMatchingDevDocsEntry(entries, 'setn');
            expect(res2.match?.name).toBe('SETNX');

            // 3. Substring match
            const res3 = findMatchingDevDocsEntry(entries, 'hash');
            expect(res3.match?.path).toBe('hget/index');

            // 4. Empty query falls back to first/overview entry
            const res4 = findMatchingDevDocsEntry(entries, '');
            expect(res4.match?.name).toBe('GET');
        });
    });

    describe('mdnProvider', () => {
        it('identifies likely MDN targets accurately', () => {
            expect(isLikelyMdnTarget('mdn:fetch')).toBe(true);
            expect(isLikelyMdnTarget('html:video')).toBe(true);
            expect(isLikelyMdnTarget('css:flex')).toBe(true);
            expect(isLikelyMdnTarget('webapi:WebSocket')).toBe(true);
            expect(isLikelyMdnTarget('fetch')).toBe(true);
            expect(isLikelyMdnTarget('websocket')).toBe(true);
            expect(isLikelyMdnTarget('Array.prototype.map')).toBe(true);
            expect(isLikelyMdnTarget('tokio')).toBe(false);
            expect(isLikelyMdnTarget('express')).toBe(false);
        });

        it('extracts search queries cleanly', () => {
            expect(extractMdnQuery('mdn:fetch')).toBe('fetch');
            expect(extractMdnQuery('html:dialog', 'showModal')).toBe('dialog showModal');
            expect(extractMdnQuery('css:grid', 'grid-template-columns')).toBe('grid-template-columns');
            expect(extractMdnQuery('css:flex', 'direction')).toBe('flex direction');
        });
    });

    describe('javadocProvider', () => {
        it('identifies valid Maven and Javadoc targets', () => {
            expect(isLikelyJavadocTarget('com.google.guava:guava')).toBe(true);
            expect(isLikelyJavadocTarget('org.springframework.boot:spring-boot-starter-web')).toBe(true);
            expect(isLikelyJavadocTarget('javadoc:org.apache.commons:commons-lang3')).toBe(true);
            expect(isLikelyJavadocTarget('maven:com.fasterxml.jackson.core:jackson-databind')).toBe(true);
            expect(isLikelyJavadocTarget('express')).toBe(false);
            expect(isLikelyJavadocTarget('react')).toBe(false);
        });
    });

    describe('Tool execution dispatching in queryDocs', () => {
        it('dispatches to mdn when source="mdn"', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '# Fetch API\n\nThe Fetch API provides an interface for fetching resources asynchronously.',
                title: 'Fetch API - Web APIs | MDN'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            registerQueryDocsTool(server, runtime);
            const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;

            const result = await toolHandler({
                library: 'fetch',
                source: 'mdn',
                cache: 'reload'
            });

            expect(mockFetchWeb).toHaveBeenCalled();
            expect(result.content[0].text).toContain('> Source: mdn | Confidence: high');
            expect(result.content[0].text).toContain('Fetch API');
        });

        it('dispatches to javadoc when source="javadoc"', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '# Package com.google.common.collect\n\nGuava collections package.',
                title: 'com.google.common.collect (Guava)'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            registerQueryDocsTool(server, runtime);
            const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;

            const result = await toolHandler({
                library: 'com.google.guava:guava',
                source: 'javadoc',
                cache: 'reload'
            });

            expect(mockFetchWeb).toHaveBeenCalledWith(expect.objectContaining({
                url: expect.stringMatching(/https:\/\/javadoc\.io\/(?:doc|static)\/com\.google\.guava\/guava/)
            }));
            expect(result.content[0].text).toContain('> Source: javadoc | Confidence: high');
            expect(result.content[0].text).toContain('Package com.google.common.collect');
        });

        it('auto-routes mdn: prefix to mdn provider in auto mode', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '# WebSocket API\n\nThe WebSocket API makes it possible to open a two-way interactive communication session.',
                title: 'WebSocket - Web APIs | MDN'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            registerQueryDocsTool(server, runtime);
            const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;

            const result = await toolHandler({
                library: 'mdn:WebSocket',
                source: 'auto',
                cache: 'reload'
            });

            expect(result.content[0].text).toContain('> Source: mdn | Confidence: high');
            expect(result.content[0].text).toContain('WebSocket API');
        });

        it('auto-routes maven coordinates to javadoc in auto mode', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '# Spring Core Framework\n\nCore support for dependency injection and IOC.',
                title: 'spring-core'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            registerQueryDocsTool(server, runtime);
            const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;

            const result = await toolHandler({
                library: 'org.springframework:spring-core',
                source: 'auto',
                cache: 'reload'
            });

            expect(result.content[0].text).toContain('> Source: javadoc | Confidence: high');
            expect(result.content[0].text).toContain('Spring Core Framework');
        });
    });
});
