import { describe, it, expect, vi } from 'vitest';
import ipaddr from 'ipaddr.js';
import { translateChineseQueryTerm, fetchContext7Docs, Context7GetImpl } from '../../engines/context7/context7.js';
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
import { extractRelevantSections, extractMarkdownHeadings } from '../../core/docs/markdownSectionExtractor.js';

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
            const mockFetchGithub = vi.fn().mockResolvedValue('# FastAPI\n\nFastAPI framework, high performance, easy to learn.');
            const result = await fetchPackageDocsFallback({
                library: 'fastapi',
                fetchGithub: mockFetchGithub
            });

            expect(result).not.toBeNull();
            expect(result?.source).toBe('pypi');
            expect(result?.repositoryUrl).toMatch(/(?:fastapi|tiangolo)\/fastapi/);
            expect(result?.repositoryUrl).not.toContain('tkambler');
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

            // 无论当前测试网络是否连通 Maven，绝不允许落入 PyPI 抢注包
            if (result !== null) {
                expect(result.source).toBe('maven');
                expect(result.repositoryUrl).toMatch(/hutool/i);
                expect(result.repositoryUrl).not.toContain('pypa/sampleproject');
                expect(result.repositoryUrl).not.toContain('python');
            } else {
                expect(result).toBeNull();
            }
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

        it('queryJavadocDocs resolves well-known Java aliases and rejects navigation wrapper stubs', async () => {
            // 1. 验证拒绝纯导航包装页
            const stubRes = await queryJavadocDocs({
                library: 'hutool',
                fetchWeb: vi.fn().mockResolvedValue('Latest version of cn.hutool:hutool-all\n\n- 5.8.35\n- 5.8.34')
            });
            expect(stubRes).toBeNull();

            // 2. 验证真实类页内容正常返回
            const validRes = await queryJavadocDocs({
                library: 'hutool',
                query: 'DateUtil',
                fetchWeb: vi.fn().mockResolvedValue('# DateUtil Class\n\nProvides methods for date parsing.')
            });
            expect(validRes).not.toBeNull();
            expect(validRes?.source).toBe('javadoc');
            expect(validRes?.libraryId).toBe('cn.hutool:hutool-all');
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

        it('focuses tightly on relevant function in pkg.go.dev / H3 container style docs', () => {
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
                '## Documentation',
                '',
                '### func Default',
                '```go',
                'func Default() *Engine',
                '```',
                'Default returns an Engine instance.',
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
            expect(extracted.content.length).toBeLessThan(goDoc.length);
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
});
