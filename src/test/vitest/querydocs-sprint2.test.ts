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
import * as httpRequest from '../../utils/httpRequest.js';

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

            // 5. Query with library/namespace prefix stripped gracefully (e.g. redis/hset, redis.hset)
            expect(findMatchingDevDocsEntry(entries, 'redis/hset').match?.name).toBe('HSET');
            expect(findMatchingDevDocsEntry(entries, 'redis.hset').match?.name).toBe('HSET');
            expect(findMatchingDevDocsEntry(entries, 'redis:hset').match?.name).toBe('HSET');
            expect(findMatchingDevDocsEntry(entries, 'redis hset').match?.name).toBe('HSET');
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

            const spy = vi.spyOn(httpRequest, 'requestDirectFirst').mockResolvedValue({
                status: 200,
                data: {
                    documents: [
                        {
                            title: 'Fetch API',
                            mdn_url: '/en-US/docs/Web/API/Fetch_API',
                            summary: 'The Fetch API provides an interface for fetching resources asynchronously.'
                        }
                    ]
                }
            } as any);

            try {
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
            } finally {
                spy.mockRestore();
            }
        });

        it('dispatches to javadoc when source="javadoc"', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '# Package com.google.common.collect\n\nGuava collections package.',
                title: 'com.google.common.collect (Guava)'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            const spy = vi.spyOn(httpRequest, 'requestDirectFirst').mockResolvedValue({
                status: 200,
                data: '<html><body><iframe src="/static/com.google.guava/guava/latest/index.html"></iframe></body></html>'
            } as any);

            try {
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
            } finally {
                spy.mockRestore();
            }
        });

        it('auto-routes mdn: prefix to mdn provider in auto mode', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '# WebSocket API\n\nThe WebSocket API makes it possible to open a two-way interactive communication session.',
                title: 'WebSocket - Web APIs | MDN'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            const spy = vi.spyOn(httpRequest, 'requestDirectFirst').mockResolvedValue({
                status: 200,
                data: {
                    documents: [
                        {
                            title: 'WebSocket API',
                            mdn_url: '/en-US/docs/Web/API/WebSocket_API',
                            summary: 'The WebSocket API makes it possible to open a two-way interactive communication session.'
                        }
                    ]
                }
            } as any);

            try {
                registerQueryDocsTool(server, runtime);
                const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;

                const result = await toolHandler({
                    library: 'mdn:WebSocket',
                    source: 'auto',
                    cache: 'reload'
                });

                expect(result.content[0].text).toContain('> Source: mdn | Confidence: high');
                expect(result.content[0].text).toContain('WebSocket API');
            } finally {
                spy.mockRestore();
            }
        });

        it('auto-routes maven coordinates to javadoc in auto mode', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const mockFetchWeb = vi.fn().mockResolvedValue({
                content: '# Spring Core Framework\n\nCore support for dependency injection and IOC.',
                title: 'spring-core'
            });
            runtime.services.fetchWeb.execute = mockFetchWeb;

            const spy = vi.spyOn(httpRequest, 'requestDirectFirst').mockResolvedValue({
                status: 200,
                data: '<html><body><iframe src="/static/org.springframework/spring-core/latest/index.html"></iframe></body></html>'
            } as any);

            try {
                registerQueryDocsTool(server, runtime);
                const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;

                const result = await toolHandler({
                    library: 'org.springframework:spring-core',
                    source: 'auto',
                    cache: 'reload'
                });

                expect(result.content[0].text).toContain('> Source: javadoc | Confidence: high');
                expect(result.content[0].text).toContain('Spring Core Framework');
            } finally {
                spy.mockRestore();
            }
        });

        it('dispatches to devdocs and gracefully handles query with library prefix and slash in library', async () => {
            const server = new McpServer({ name: 'test-server', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            const spy = vi.spyOn(httpRequest, 'requestDirectFirst').mockImplementation(async (_method, url) => {
                if (url.includes('/docs.json')) {
                    return { status: 200, data: [{ name: 'Redis', slug: 'redis' }] } as any;
                }
                if (url.includes('/redis/index.json')) {
                    return { status: 200, data: { entries: [{ name: 'HSET', path: 'hset/index', type: 'Core: Hash' }] } } as any;
                }
                if (url.includes('/redis/hset/index.html')) {
                    return { status: 200, data: '<h1>HSET</h1><p>Sets field in the hash stored at key to value.</p>' } as any;
                }
                return { status: 404, data: 'Not Found' } as any;
            });

            try {
                registerQueryDocsTool(server, runtime);
                const toolHandler = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })._registeredTools['queryDocs']?.handler;

                // 1. query 带 redis/hset 前缀
                const res1 = await toolHandler({
                    library: 'redis',
                    query: 'redis/hset',
                    source: 'devdocs',
                    cache: 'reload'
                });
                expect(res1.content[0].text).toContain('> Source: devdocs | Confidence: high');
                expect(res1.content[0].text).toContain('# HSET');

                // 2. library 直接传入 redis/hset，自动拆分
                const res2 = await toolHandler({
                    library: 'redis/hset',
                    source: 'devdocs',
                    cache: 'reload'
                });
                expect(res2.content[0].text).toContain('> Source: devdocs | Confidence: high');
                expect(res2.content[0].text).toContain('# HSET');
            } finally {
                spy.mockRestore();
            }
        });

        it('shares directSlowHostCache between parent domain and subdomains', () => {
            httpRequest.__resetDirectSlowHostCacheForTests();

            // 标记 devdocs.io 为慢主机
            httpRequest.markHostDirectSlow('https://devdocs.io/docs.json');

            // documents.devdocs.io 应自动继承慢主机标记
            expect(httpRequest.isHostMarkedDirectSlow('https://documents.devdocs.io/redis/index.json')).toBe(true);

            // 错误消息中的 TLS 和 socket disconnected 均被判定为网络层错误
            expect(httpRequest.isNetworkLayerError('Client network socket disconnected before secure TLS connection was established')).toBe(true);
            expect(httpRequest.isNetworkLayerError('TLS handshake failed')).toBe(true);
        });
    });
});
