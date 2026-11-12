import { describe, it, expect, vi } from 'vitest';
import ipaddr from 'ipaddr.js';
import {
    translateChineseQueryTerm,
    fetchContext7Docs,
    Context7GetImpl,
    context7GetWithRetry,
    isContext7TransientNetworkError
} from '../../engines/context7/context7.js';
import { pickBestLibrary } from '../../core/context7/context7Service.js';
import {
    resolvePackageMetadata,
    fetchPackageDocsFallback,
    CORE_LANGUAGES_AND_TOOLS,
    isPythonPackageName,
    isRustCrateName,
    isGoModuleName,
    isJavaPackageName
} from '../../core/docs/packageDocsFallback.js';
import { queryMdnDocs } from '../../core/docs/mdnProvider.js';
import { queryJavadocDocs } from '../../core/docs/javadocProvider.js';
import * as httpRequest from '../../utils/httpRequest.js';
import {
    extractRelevantSections,
    extractMarkdownHeadings,
    isJavadocClassDocument
} from '../../core/docs/markdownSectionExtractor.js';
import { formatQueryDocsMarkdown } from '../../tools/handlers/queryDocsTool.js';

describe('queryDocs A/B Fixes Suite (P0/P1/P2 resolution)', () => {
    describe('P0-1: Context7 no_relevant_snippets handling', () => {
        it('translates common Chinese technical terms to standard English terms', () => {
            expect(translateChineseQueryTerm('装饰器')).toBe('decorator');
            expect(translateChineseQueryTerm('中间件配置')).toBe('middleware configuration');
            expect(translateChineseQueryTerm('异步任务')).toBe('asyncio 任务');
            expect(translateChineseQueryTerm('english query')).toBeNull();
        });

        it('automatically retries translated English query on 404 no_relevant_snippets', async () => {
            const mockGet: Context7GetImpl = vi.fn()
                .mockImplementation(async (_url: string, params?: Record<string, unknown>) => {
                    const q = params?.query;
                    if (q === '装饰器') {
                        const err = new Error('Not found') as any;
                        err.response = { status: 404, data: { error: 'no_relevant_snippets' } };
                        throw err;
                    }
                    if (q === 'decorator') {
                        return {
                            status: 200,
                            data: {
                                codeSnippets: [{
                                    codeTitle: 'Decorator Example',
                                    codeList: [{ code: 'def my_decorator(): pass' }]
                                }],
                                infoSnippets: []
                            }
                        } as any;
                    }
                    throw new Error(`Unexpected query: ${q}`);
                });

            const result = await fetchContext7Docs('/python/cpython', '装饰器', 5, 0, mockGet);
            expect(result.codeSnippets).toHaveLength(1);
            expect(result.codeSnippets[0].codeTitle).toBe('Decorator Example');
            expect(result.warnings?.some((w) => w.includes('mapped from "装饰器" to "decorator"'))).toBe(true);
        });

        it('falls back to overview on 404 no_relevant_snippets when translation is unavailable or fails', async () => {
            const mockGet: Context7GetImpl = vi.fn()
                .mockImplementation(async (_url: string, params?: Record<string, unknown>) => {
                    const q = params?.query;
                    if (q === 'nonexistent_feature') {
                        const err = new Error('Not found') as any;
                        err.response = { status: 404, data: { error: 'no_relevant_snippets' } };
                        throw err;
                    }
                    if (q === 'overview') {
                        return {
                            status: 200,
                            data: {
                                codeSnippets: [],
                                infoSnippets: [{
                                    title: 'Python Overview',
                                    content: 'Python is a high-level programming language.'
                                }]
                            }
                        } as any;
                    }
                    throw new Error(`Unexpected query: ${q}`);
                });

            const result = await fetchContext7Docs('/python/cpython', 'nonexistent_feature', 5, 0, mockGet);
            expect(result.infoSnippets).toHaveLength(1);
            expect(result.infoSnippets[0].title).toBe('Python Overview');
            expect(result.warnings?.some((w) => w.includes('Showing library overview instead'))).toBe(true);
        });

        it('handles Context7 infoSnippets without title (actual upstream structure) safely without throwing', async () => {
            const mockGet: Context7GetImpl = vi.fn().mockResolvedValue({
                status: 200,
                data: {
                    codeSnippets: [
                        { codeTitle: 'QueryWrapper Example', codeList: [{ code: 'new QueryWrapper<User>().eq("name", "Tom");' }] }
                    ],
                    // Real Context7 response structure: has breadcrumb and content, no title field!
                    infoSnippets: [
                        { breadcrumb: 'MyBatis-Plus > Quick Start', content: 'MyBatis-Plus is an enhanced toolkit for MyBatis.', rank: 1 },
                        { breadcrumb: 'MyBatis-Plus > Quick Start', content: 'MyBatis-Plus is an enhanced toolkit for MyBatis.', rank: 2 },
                        { breadcrumb: 'MyBatis-Plus > Pagination', content: 'Pagination plugin configuration.', rank: 3 }
                    ]
                }
            } as any);

            const result = await fetchContext7Docs('/baomidou/mybatis-plus', 'pagination', 5, 0, mockGet);
            expect(result).not.toBeNull();
            expect(result.codeSnippets).toHaveLength(1);
            expect(result.infoSnippets).toHaveLength(2); // deduped from 3 to 2
        });

        it('deduplicates identical code snippets and info snippets', async () => {
            const mockGet: Context7GetImpl = vi.fn().mockResolvedValue({
                status: 200,
                data: {
                    codeSnippets: [
                        { codeTitle: 'HSET', codeList: [{ code: 'HSET key field value' }] },
                        { codeTitle: 'HSET', codeList: [{ code: 'HSET key field value' }] },
                        { codeTitle: 'HGET', codeList: [{ code: 'HGET key field' }] }
                    ],
                    infoSnippets: [
                        { title: 'Redis Hashes', content: 'Hashes are maps between string fields and values.' },
                        { title: 'Redis Hashes', content: 'Hashes are maps between string fields and values.' }
                    ]
                }
            } as any);

            const result = await fetchContext7Docs('/redis/redis', 'hset', 5, 0, mockGet);
            expect(result.codeSnippets).toHaveLength(2);
            expect(result.infoSnippets).toHaveLength(1);
        });
    });

    describe('P1-3: Ecosystem disambiguation and package metadata', () => {
        it('identifies ecosystem affinities accurately', () => {
            expect(isPythonPackageName('fastapi')).toBe(true);
            expect(isPythonPackageName('django')).toBe(true);
            expect(isPythonPackageName('pytest')).toBe(true);
            expect(isRustCrateName('tokio')).toBe(true);
            expect(isRustCrateName('serde')).toBe(true);
            expect(isGoModuleName('gin')).toBe(true);
            expect(isGoModuleName('echo')).toBe(true);
        });

        it('resolves core languages/tools directly without probing npm', async () => {
            const pythonMeta = await resolvePackageMetadata('python');
            expect(pythonMeta).not.toBeNull();
            expect(pythonMeta?.source).toBe('official');
            expect(pythonMeta?.repositoryUrl).toBe('https://github.com/python/cpython');
            expect(pythonMeta?.documentationUrl).toBe('https://docs.python.org/3');

            const redisMeta = await resolvePackageMetadata('redis');
            expect(redisMeta?.repositoryUrl).toBe('https://github.com/redis/redis');
            expect(redisMeta?.documentationUrl).toBe('https://redis.io/docs');
        });

        it('fetches official repository README directly for core languages in fallback', async () => {
            const mockFetchGithub = vi.fn().mockResolvedValue('# Python\n\nOfficial Python documentation and programming language source repository.');
            const result = await fetchPackageDocsFallback({
                library: 'python',
                fetchGithub: mockFetchGithub
            });

            expect(result).not.toBeNull();
            expect(result?.source).toBe('github-readme');
            expect(result?.confidence).toBe('high');
            expect(result?.repositoryUrl).toBe('https://github.com/python/cpython');
            expect(mockFetchGithub).toHaveBeenCalledWith('https://github.com/python/cpython');
        });

        it('prioritizes PyPI for known Python packages in fallback', async () => {
            const spy = vi.spyOn(httpRequest, 'requestDirectFirst').mockImplementation(async (_method, url) => {
                if (url.includes('pypi.org/pypi/fastapi')) {
                    return {
                        status: 200,
                        data: {
                            info: {
                                name: 'fastapi',
                                version: '0.115.0',
                                project_urls: {
                                    Homepage: 'https://fastapi.tiangolo.com/',
                                    Repository: 'https://github.com/fastapi/fastapi'
                                }
                            }
                        }
                    } as any;
                }
                throw new Error(`Unexpected url: ${url}`);
            });

            try {
                const mockFetchGithub = vi.fn().mockResolvedValue('# FastAPI\n\nFastAPI framework, high performance, easy to learn.');
                const result = await fetchPackageDocsFallback({
                    library: 'fastapi',
                    fetchGithub: mockFetchGithub
                });

                expect(result).not.toBeNull();
                expect(result?.source).toBe('pypi');
                expect(result?.repositoryUrl).toMatch(/(?:fastapi|tiangolo)\/fastapi/);
                expect(result?.repositoryUrl).not.toContain('tkambler');
            } finally {
                spy.mockRestore();
            }
        });

        it('prevents Java packages like hutool from falling back to PyPI sampleproject', async () => {
            const mockFetchGithub = vi.fn().mockImplementation(async (url: string) => {
                if (url.includes('hutool')) {
                    return '# Hutool\n\nA set of Java tools that keep Java sweet and simple.';
                }
                return '# Sample Project\n\nA sample Python project.';
            });

            const result = await fetchPackageDocsFallback({
                library: 'hutool',
                fetchGithub: mockFetchGithub
            });

            expect(result).not.toBeNull();
            expect(result!.source).toBe('maven');
            expect(result!.repositoryUrl).toBe('https://github.com/dromara/hutool');
            expect(result!.readme).toContain('Hutool');
            expect(result!.repositoryUrl).not.toContain('pypa/sampleproject');
            expect(result!.repositoryUrl).not.toContain('python');
        });

        it('strictly returns null and blocks fallback to npm/PyPI when an unknown Java-like package cannot be found', async () => {
            const mockFetchGithub = vi.fn().mockResolvedValue('# Fake Python Package\n\nSample code.');
            // 'java-unknown-lib' matches isJavaPackageName because it starts with 'java-'
            const result = await fetchPackageDocsFallback({
                library: 'java-unknown-nonexistent-package-xyz',
                fetchGithub: mockFetchGithub
            });

            // Must strictly return null, NEVER falling through to npm or PyPI
            expect(result).toBeNull();
            expect(mockFetchGithub).not.toHaveBeenCalled();
        });

        it('isJavaPackageName uses safe prototype check and does not leak prototype keys', () => {
            expect(isJavaPackageName('constructor')).toBe(false);
            expect(isJavaPackageName('__proto__')).toBe(false);
            expect(isJavaPackageName('toString')).toBe(false);
            expect(isJavaPackageName('valueOf')).toBe(false);
            expect(isJavaPackageName('hutool')).toBe(true);
            expect(isJavaPackageName('guava')).toBe(true);
            expect(isJavaPackageName('mybatis-plus')).toBe(true);
        });

        it('queryJavadocDocs resolves well-known Java aliases and rejects navigation and frame warning stubs', async () => {
            vi.spyOn(httpRequest, 'requestDirectFirst').mockImplementation(async (_method, url) => {
                if (String(url).includes('type-search-index.js')) {
                    return {
                        status: 200,
                        data: '[{"p":"cn.hutool.core.date","l":"DateUtil"}]'
                    } as any;
                }
                return {
                    status: 200,
                    data: '<html><iframe src="/static/cn.hutool/hutool-all/5.8.35/index.html"></iframe></html>'
                } as any;
            });

            // 1. 验证拒绝纯导航包装页
            const stubRes = await queryJavadocDocs({
                library: 'hutool',
                fetchWeb: vi.fn().mockResolvedValue('Latest version of cn.hutool:hutool-all\n\n- 5.8.35\n- 5.8.34')
            });
            expect(stubRes).toBeNull();

            // 2. 验证拒绝 Frame Alert / 框架预警页面
            const frameRes = await queryJavadocDocs({
                library: 'hutool',
                fetchWeb: vi.fn().mockResolvedValue('<h2>Frame Alert</h2><p>This document is designed to be viewed using the frames feature.</p>')
            });
            expect(frameRes).toBeNull();

            // 3. 验证带 query 时若未命中具体类而落在根 index.html，返回 null 让上层退回 Context7
            const unlocatedRes = await queryJavadocDocs({
                library: 'hutool',
                query: '分页插件',
                fetchWeb: vi.fn().mockResolvedValue('# Package cn.hutool.all\n\nPackage overview.')
            });
            expect(unlocatedRes).toBeNull();

            // 4. 验证命中具体类时真实类页内容正常返回
            const validRes = await queryJavadocDocs({
                library: 'hutool',
                query: 'DateUtil',
                fetchWeb: vi.fn().mockResolvedValue('# DateUtil Class\n\nProvides methods for date parsing.')
            });
            expect(validRes).not.toBeNull();
            expect(validRes?.source).toBe('javadoc');
            expect(validRes?.libraryId).toBe('cn.hutool:hutool-all');
            expect(validRes?.content).toContain('DateUtil');
        });
    });

    describe('P1-4: MDN slug and title validation', () => {
        it('scores and selects matching API document over irrelevant method names', async () => {
            const mockFetchWeb = vi.fn().mockResolvedValue('# Fetch API\n\nFetch specification documentation.');

            // Mock searchMdn by testing queryMdnDocs behavior
            const result = await queryMdnDocs({
                library: 'fetch',
                query: 'request options',
                fetchWeb: mockFetchWeb
            });

            if (result) {
                // Must not be OPTIONS HTTP method page
                expect(result.documentationUrl.toLowerCase()).not.toContain('/methods/options');
                expect(result.confidence).toBe('high');
            }
        });
    });

    describe('P1-6: markdownSectionExtractor dynamic heading level', () => {
        it('cleans section markers and extracts H3/H4 headings in docs.rs style docs', () => {
            const docsRsMarkdown = [
                '# Crate tokio',
                'A runtime for writing reliable network applications.',
                '',
                '### [§](#working-with-tasks)Working With Tasks',
                'Spawning tasks with tokio::spawn allows concurrent execution.',
                '',
                '### [§](#macros)Macros',
                '#### [§](#select)select!',
                'Waits on multiple concurrent branches, returning when the first completes.',
                '```rust',
                'tokio::select! {',
                '    val = rx1.recv() => println!("rx1: {:?}", val),',
                '    val = rx2.recv() => println!("rx2: {:?}", val),',
                '}',
                '```',
                '',
                '### [§](#asynchronous-io)Asynchronous IO',
                'AsyncRead and AsyncWrite traits provide async I/O.'
            ].join('\n');

            const headings = extractMarkdownHeadings(docsRsMarkdown);
            expect(headings.some((h) => h.title.includes('Macros'))).toBe(true);
            expect(headings.every((h) => !h.title.startsWith('§'))).toBe(true);

            // Pad length to > 8000 to trigger extraction
            const longDocsRs = docsRsMarkdown + '\n\n' + 'Filler content for length.\n'.repeat(350);
            const extracted = extractRelevantSections(longDocsRs, 'select! 宏');
            expect(extracted.isFocused).toBe(true);
            expect(extracted.focusedSectionTitles?.some((t) => t.toLowerCase().includes('macro'))).toBe(true);
            expect(extracted.content).toContain('tokio::select!');
        });

        it('focuses tightly on relevant function in pkg.go.dev with real multi-H2 structure', () => {
            const goDoc = [
                '# Package gin',
                'Package gin implements a HTTP web framework.',
                '',
                '## Overview',
                'Gin is a HTTP web framework written in Go.',
                '',
                '## Index',
                '- func Default() *Engine',
                '- func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes',
                '',
                '## Constants',
                'const Version = "v1.9.1"',
                '',
                '## Variables',
                'var DebugPrintRouteFunc func(httpMethod, absolutePath, handlerName string, nuHandlers int)',
                '',
                '## Functions',
                '',
                '### func CreateTestContext',
                'CreateTestContext returns a fresh engine and context for testing.',
                '',
                '### func Default',
                'Default returns an Engine instance.',
                '',
                '## Types',
                '',
                '### type Context',
                'Context is the most important part of gin. It allows passing variables between handlers.',
                '',
                '### func (group *RouterGroup) Use',
                '```go',
                'func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes',
                '```',
                'Use attaches a global middleware to the router group.',
                '',
                '### func (c *Context) JSON',
                '```go',
                'func (c *Context) JSON(code int, obj any)',
                '```',
                'JSON serializes the given struct as JSON.',
                '',
                '### func (c *Context) Next',
                '```go',
                'func (c *Context) Next()',
                '```',
                'Next executes the pending handlers in the chain.',
                '',
                'Filler content to exceed 8000 chars.\n'.repeat(300)
            ].join('\n');

            const extracted = extractRelevantSections(goDoc, 'middleware');
            expect(extracted.isFocused).toBe(true);
            expect(extracted.content).toContain('RouterGroup) Use');
            expect(extracted.content).toContain('Use attaches a global middleware');
            expect(extracted.content.length).toBeLessThan(3500);
        });

        it('focuses relevant excerpts even when document has NO Markdown headings (headings.length < 2, like real pkg.go.dev)', () => {
            // Real pkg.go.dev documents often render with just a single title and flat paragraphs / code blocks without ## or ###
            const flatGoDoc = [
                '# Package gin',
                'Package gin implements a HTTP web framework called gin.',
                '',
                'Constants and variables for gin web engine.',
                'Default returns an Engine instance with the Logger and Recovery middleware already attached.',
                '',
                'func CreateTestContext(w http.ResponseWriter) (c *Context, r *Engine)',
                'CreateTestContext returns a fresh engine and context for testing.',
                '',
                'func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes',
                'Use attaches a global middleware to the router group. For the example, see the test cases.',
                '```go',
                'r := gin.New()',
                'r.Use(gin.Logger())',
                '```',
                '',
                'func (c *Context) JSON(code int, obj any)',
                'JSON serializes the given struct as JSON into the response body.',
                '',
                'Massive filler content without any headings to simulate 30KB of documentation.\n'.repeat(400)
            ].join('\n');

            const extracted = extractRelevantSections(flatGoDoc, 'middleware');
            expect(extracted.isFocused).toBe(true);
            expect(extracted.content).toContain('Use attaches a global middleware');
            expect(extracted.content.length).toBeLessThan(3500);
        });

        it('safely handles query with regex special characters like map( or a[b without throwing', () => {
            const sampleDoc = [
                '# Package maptest',
                'func (m *Map) map(key string, val any) bool',
                'map assigns the value to key.',
                'More lines.\n'.repeat(800)
            ].join('\n');

            expect(() => extractRelevantSections(sampleDoc, 'map(')).not.toThrow();
            const res1 = extractRelevantSections(sampleDoc, 'map(');
            expect(res1.isFocused).toBe(true);

            expect(() => extractRelevantSections(sampleDoc, 'a[b')).not.toThrow();
            expect(() => extractRelevantSections(sampleDoc, 'func(c*Context)')).not.toThrow();
            expect(() => extractRelevantSections(sampleDoc, 'key*+?^$')).not.toThrow();
        });

        it('strictly limits excerpt budget to < 4000 characters even when best block itself is 20KB', () => {
            const massiveBlock = [
                '# Package gin',
                'Preamble overview before the massive block.',
                '',
                'Massive single block line without double newlines.\n'.repeat(200) +
                'func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes\n' +
                'Use attaches a global middleware to the router group.\n' +
                'Trailing massive single block lines without double newlines.\n'.repeat(200)
            ].join('\n');

            const extracted = extractRelevantSections(massiveBlock, 'middleware');
            expect(extracted.isFocused).toBe(true);
            expect(extracted.content).toContain('Use attaches a global middleware');
            expect(extracted.content.length).toBeLessThan(4000);
            expect(extracted.content.length).toBeGreaterThan(500);
        });

        it('skips TOC index links and anchors onto function implementation and usage body in massive pkg.go.dev documents', () => {
            // pkg.go.dev documents place a huge index of - [func ...](#...) at the top
            const tocAndBodyDoc = [
                '# Package gin',
                'Package gin implements an HTTP web framework.',
                '',
                '## Index',
                '- [func CreateTestContext(w http.ResponseWriter) (c *Context, r *Engine)](#CreateTestContext)',
                '- [func Default() *Engine](#Default)',
                '- [func (engine *Engine) Use(middleware ...HandlerFunc) IRoutes](#Engine.Use)',
                '- [func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes](#RouterGroup.Use)',
                '- [func New() *Engine](#New)',
                '- [func (c *Context) JSON(code int, obj any)](#Context.JSON)',
                '',
                'Filler index lines to simulate large package index.\n'.repeat(300) +
                '\n' +
                '### func (group *RouterGroup) Use\n\n' +
                '```go\n' +
                'func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes\n' +
                '```\n' +
                'Use attaches a global middleware to the router group. For the example, see the test cases.\n' +
                'Example usage:\n' +
                '```go\n' +
                'router := gin.New()\n' +
                'router.Use(gin.Logger())\n' +
                '```\n\n' +
                'Trailing substantive body lines.\n'.repeat(300)
            ].join('\n');

            const extracted = extractRelevantSections(tocAndBodyDoc, 'middleware');
            expect(extracted.isFocused).toBe(true);
            // Must contain the actual usage and code block, NOT just the index link
            expect(extracted.content).toContain('Use attaches a global middleware to the router group');
            expect(extracted.content).toContain('router.Use(gin.Logger())');
            // Must NOT start in or be dominated by the index link table
            expect(extracted.content).not.toContain('## Index');
            expect(extracted.content).not.toContain('(#Engine.Use)');
        });

        it('skips TOC index links in completely flat single-block pkg.go.dev docs (headings.length < 2)', () => {
            const flatPkgDoc = [
                '# Package gin',
                'Package gin implements an HTTP web framework.',
                '',
                'Index table of functions:',
                '- [func CreateTestContext(w http.ResponseWriter) (c *Context, r *Engine)](#CreateTestContext)',
                '- [func Default() *Engine](#Default)',
                '- [func (engine *Engine) Use(middleware ...HandlerFunc) IRoutes](#Engine.Use)',
                '- [func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes](#RouterGroup.Use)',
                '- [func New() *Engine](#New)',
                'Filler link list lines.\n'.repeat(250) +
                '\n' +
                'Documentation Section for RouterGroup.Use:\n' +
                '```go\n' +
                'func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes\n' +
                '```\n' +
                'Use attaches a global middleware to the router group. For the example, see the test cases.\n' +
                'router.Use(gin.Logger())\n' +
                'Trailing documentation lines.\n'.repeat(250)
            ].join('\n');

            const extracted = extractRelevantSections(flatPkgDoc, 'middleware');
            expect(extracted.isFocused).toBe(true);
            expect(extracted.content).toContain('Use attaches a global middleware to the router group');
            expect(extracted.content).toContain('router.Use(gin.Logger())');
            expect(extracted.content).not.toContain('(#Engine.Use)');
            expect(extracted.content.length).toBeLessThan(4000);
        });

        it('does not truncate Javadoc class pages and skips window extraction', () => {
            const javadocPage = [
                '# Class ImmutableList<E>',
                'java.lang.Object',
                '  extended by com.google.common.collect.ImmutableCollection<E>',
                '      extended by com.google.common.collect.ImmutableList<E>',
                'All Implemented Interfaces: Serializable, Iterable<E>, Collection<E>, List<E>, RandomAccess',
                '',
                'A List whose contents will never change, with many other important properties associated with being immutable.',
                'Method Summary:',
                '- asList()',
                '- builder()',
                '- copyOf(Collection elements)',
                '',
                'Detailed method descriptions and parameters.\n'.repeat(250)
            ].join('\n');

            expect(isJavadocClassDocument(javadocPage)).toBe(true);

            // 1. extractRelevantSections 直接保持全量，不触发无标题窗口截断
            const extracted = extractRelevantSections(javadocPage, 'ImmutableList');
            expect(extracted.isFocused).toBe(false);
            expect(extracted.content).toBe(javadocPage.trim());

            // 2. formatQueryDocsMarkdown 在 source: 'javadoc' 时不进行截断
            const formatted = formatQueryDocsMarkdown({
                libraryId: 'com.google.guava:guava',
                source: 'javadoc',
                documentationUrl: 'https://javadoc.io/doc/com.google.guava/guava/latest/com/google/common/collect/ImmutableList.html',
                query: 'ImmutableList',
                content: javadocPage
            });
            expect(formatted).not.toContain('Focused Excerpt');
            expect(formatted).not.toContain('preceding sections truncated');
            expect(formatted).toContain('All Implemented Interfaces');
            expect(formatted).toContain('Method Summary');
        });
    });

    describe('P2-7: IPv6 match IPv4 CIDR compatibility', () => {
        it('evaluates IPv6 address against IPv4 CIDR without throwing', () => {
            const ipv6 = ipaddr.IPv6.parse('2606:4700::6810:85e5');
            const ipv4Cidr = ipaddr.parseCIDR('198.18.0.0/15');

            // Must return false cleanly, not throw
            expect(() => ipv6.match(ipv4Cidr)).not.toThrow();
            expect(ipv6.match(ipv4Cidr)).toBe(false);

            // Standard range checks must still work properly
            expect(ipaddr.IPv4.parse('127.0.0.1').range()).toBe('loopback');
            expect(ipaddr.IPv6.parse('2001::1').range()).toBe('teredo');
        });
    });

    describe('Context7 transient network retry & guava official hints', () => {
        it('isContext7TransientNetworkError accurately recognizes transient network errors', () => {
            expect(isContext7TransientNetworkError(new Error('Client network socket disconnected before secure TLS connection was established'))).toBe(true);
            expect(isContext7TransientNetworkError({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(true);
            expect(isContext7TransientNetworkError({ message: 'socket hang up' })).toBe(true);
            expect(isContext7TransientNetworkError({ code: 'ETIMEDOUT' })).toBe(true);

            // Non-transient errors
            expect(isContext7TransientNetworkError(null)).toBe(false);
            expect(isContext7TransientNetworkError(new Error('Bad Request'))).toBe(false);
            expect(isContext7TransientNetworkError({ response: { status: 404 } })).toBe(false);
        });

        it('context7GetWithRetry retries transient network errors and succeeds on recovery', async () => {
            let calls = 0;
            const mockGet: Context7GetImpl = vi.fn().mockImplementation(async () => {
                calls++;
                if (calls === 1) {
                    throw new Error('Client network socket disconnected before secure TLS connection was established');
                }
                return { status: 200, data: { ok: true } } as any;
            });

            const res = await context7GetWithRetry('https://context7.com/api/test', {}, 3, mockGet);
            expect(res.status).toBe(200);
            expect(res.data).toEqual({ ok: true });
            expect(calls).toBe(2);
        });

        it('context7GetWithRetry does not retry non-transient non-5xx errors like 400', async () => {
            let calls = 0;
            const mockGet: Context7GetImpl = vi.fn().mockImplementation(async () => {
                calls++;
                const err = new Error('Bad Request') as any;
                err.response = { status: 400, data: { error: 'invalid_params' } };
                throw err;
            });

            await expect(context7GetWithRetry('https://context7.com/api/test', {}, 3, mockGet)).rejects.toThrow('Bad Request');
            expect(calls).toBe(1);
        });

        it('pickBestLibrary prefers google/guava over websites/guava_dev for guava', () => {
            const candidates = [
                { id: '/websites/guava_dev', title: 'guava.dev', totalSnippets: 100 },
                { id: '/google/guava', title: 'Google Guava', totalSnippets: 80 }
            ] as any[];

            const chosen = pickBestLibrary(candidates, 'guava');
            expect(chosen).toBeDefined();
            expect(chosen!.id).toBe('/google/guava');
        });
    });

    describe('P1-8: Real-world API matching, cross-lingual tech terms, and Javadoc retry', () => {
        it('accurately matches "## Macros" and excludes "### WASM support" for query "select! 宏"', () => {
            const docsRsMarkdown = [
                '# Crate tokio',
                'A runtime for writing reliable network applications.',
                '',
                '## Supported platforms',
                'Tokio supports a wide variety of platforms.',
                '',
                '### WASM support',
                'Tokio has some limited support for Wasm platforms.',
                'Many features are restricted on Wasm targets.',
                'Wasm is experimental.',
                'Filler Wasm content with various platform details.\n'.repeat(120),
                '',
                '## Macros',
                '### select!',
                'Waits on multiple concurrent branches, returning when the first completes.',
                '```rust',
                'tokio::select! {',
                '    val = rx1.recv() => println!("rx1: {:?}", val),',
                '    val = rx2.recv() => println!("rx2: {:?}", val),',
                '}',
                '```',
                'Macro usage details and documentation text.\n'.repeat(120),
                '',
                '## Modules',
                'Various submodules.'
            ].join('\n');

            const extracted = extractRelevantSections(docsRsMarkdown, 'select! 宏');
            expect(extracted.isFocused).toBe(true);
            expect(extracted.focusedSectionTitles).toBeDefined();
            // 必须精准命中 Macros，严禁误将 WASM support 当作核心段落
            expect(extracted.focusedSectionTitles?.some((t) => t.toLowerCase().includes('macro'))).toBe(true);
            expect(extracted.focusedSectionTitles?.some((t) => t.toLowerCase().includes('wasm'))).toBe(false);
            expect(extracted.content).toContain('tokio::select!');
            expect(extracted.content).toContain('Waits on multiple concurrent branches');
        });

        it('focuses on H4 method declaration in pkg.go.dev for query "middleware"', () => {
            const goDoc = [
                '# Package gin',
                'Package gin implements an HTTP web framework.',
                '',
                '## Documentation',
                '',
                '### Overview',
                'Gin is a HTTP web framework written in Go.',
                '',
                '### Index',
                '- [func Default() *Engine](#Default)',
                '- [func (engine *Engine) Use(middleware ...HandlerFunc) IRoutes](#Engine.Use)',
                '- [func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes](#RouterGroup.Use)',
                '',
                '### Functions',
                '#### func Default',
                'Default returns an Engine instance.',
                '',
                '### Types',
                '#### type Engine',
                'Engine is the state machine.',
                '',
                '#### func (*Engine) Use',
                '```go',
                'func (engine *Engine) Use(middleware ...HandlerFunc) IRoutes',
                '```',
                'Use attaches a global middleware to the router. i.e. the middleware attached through Use() will be included in the handlers chain for every single request.',
                '',
                '#### func (*RouterGroup) Use',
                '```go',
                'func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes',
                '```',
                'Use attaches a middleware to the router group.',
                '',
                'Filler documentation lines to exceed threshold.\n'.repeat(250)
            ].join('\n');

            const extracted = extractRelevantSections(goDoc, 'middleware');
            expect(extracted.isFocused).toBe(true);
            expect(extracted.focusedSectionTitles?.some((t) => t.includes('Use'))).toBe(true);
            expect(extracted.content).toContain('func (engine *Engine) Use(middleware ...HandlerFunc)');
            expect(extracted.content).toContain('Use attaches a global middleware to the router');
            expect(extracted.content).not.toContain('### Index');
        });

        it('strips punctuation in query like "map(" to locate function and caps missing query overview at < 3500 chars', () => {
            const docWithMap = [
                '# Flat Module Reference',
                'Introduction to flat reference without heading trees.',
                '',
                'Some general notes on utilities and helper functions.',
                'Filler introductory text with various details.\n'.repeat(150),
                '',
                'func map(input []string, fn func(string) string) []string {',
                '    // transform string slice',
                '    result := make([]string, len(input))',
                '    return result',
                '}',
                '',
                'Documentation on map transforms and usage examples.',
                'Trailing documentation text with various details.\n'.repeat(150)
            ].join('\n');

            // 1. 带标点的 "map(" 自动剥离标点重试并命中 map 声明
            const extractedMap = extractRelevantSections(docWithMap, 'map(');
            expect(extractedMap.isFocused).toBe(true);
            expect(extractedMap.content).toContain('func map(input []string');

            // 2. 彻底不存在的 query 触发优雅概览降级，且字数严控在 < 3500 字符内
            const extractedMissing = extractRelevantSections(docWithMap, 'completely_nonexistent_token_xyz999');
            expect(extractedMissing.isFocused).toBe(false);
            expect(extractedMissing.content).toContain('Document Overview');
            expect(extractedMissing.content).toContain('No exact matches found for "completely_nonexistent_token_xyz999"');
            expect(extractedMissing.content.length).toBeLessThan(3500);

            // 3. 在有标题结构的长文档中，带有标点的 "map(" 不会落到 Index 目录清单，而是命中真实函数
            const structuredDocWithIndex = [
                '# Package util',
                'Overview of util package.',
                '',
                '### Index',
                '- [func MapKeys(m map[string]string) []string](#MapKeys)',
                '- [func MapValues(m map[string]string) []string](#MapValues)',
                '- [func MapEntries(m map[string]string) []string](#MapEntries)',
                '- [func MapFilter(m map[string]string) []string](#MapFilter)',
                '- [func MapReduce(m map[string]string) []string](#MapReduce)',
                '- [func MapTransform(m map[string]string) []string](#MapTransform)',
                '',
                '### Functions',
                '#### func MapKeys',
                '```go',
                'func MapKeys(m map[string]string) []string',
                '```',
                'MapKeys returns the keys of the map of all pairs.',
                'Filler text for length.\n'.repeat(350)
            ].join('\n');

            const extractedStructured = extractRelevantSections(structuredDocWithIndex, 'map(');
            expect(extractedStructured.isFocused).toBe(true);
            // 严禁落入 Index 目录
            expect(extractedStructured.focusedSectionTitles).not.toContain('Index');
            expect(extractedStructured.content).toContain('func MapKeys');
        });

        it('retries Javadoc wrapperUrl and index probe on transient network failure', async () => {
            let directFirstCalls = 0;
            const spy = vi.spyOn(httpRequest, 'requestDirectFirst').mockImplementation(async (method, url) => {
                directFirstCalls++;
                if (url.includes('index.html')) {
                    if (directFirstCalls === 1) {
                        // 第 1 次探测包装页遭遇瞬时断连异常
                        throw new Error('Client network socket disconnected before secure TLS connection was established');
                    }
                    // 第 2 次重试成功
                    return {
                        status: 200,
                        data: '<html><body><iframe src="/static/com.google.guava/guava/33.0.0-jre/index.html"></iframe></body></html>'
                    } as any;
                }
                if (url.includes('type-search-index.js')) {
                    return {
                        status: 200,
                        data: '[{"p":"com.google.common.collect","l":"ImmutableList"}]'
                    } as any;
                }
                throw new Error(`Unexpected url: ${url}`);
            });

            try {
                const fetchWebMock = vi.fn().mockResolvedValue(`
# Class ImmutableList<E>
Method Summary:
- asList()
- builder()
Detailed ImmutableList class documentation.
                `);

                const result = await queryJavadocDocs({
                    library: 'guava',
                    query: 'ImmutableList',
                    fetchWeb: fetchWebMock
                });

                expect(result).not.toBeNull();
                expect(result?.documentationUrl).toBe('https://javadoc.io/static/com.google.guava/guava/33.0.0-jre/com/google/common/collect/ImmutableList.html');
                expect(result?.content).toContain('Class ImmutableList<E>');
                expect(directFirstCalls).toBeGreaterThanOrEqual(2);
            } finally {
                spy.mockRestore();
            }
        });
    });
});
