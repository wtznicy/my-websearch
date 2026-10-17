import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchGithubReadme, fetchGithubContent, renderAsciiTree, __resetGithubReadmeCacheForTests } from '../../engines/github/github.js';
import { isGithubIssueIntent, formatStars } from '../../engines/github/githubSearch.js';
import { createWebFetchService } from '../../core/fetch/fetchServices.js';
import axios from 'axios';

describe('fetchGithubContent / fetchGithubReadme extended capabilities', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        __resetGithubReadmeCacheForTests();
    });

    it('identifies blob URL and formats source code inside language code block', async () => {
        const mockRequest = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: 'export const hello = "world";',
            headers: {}
        });
        vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: '',
            headers: {}
        });

        const result = await fetchGithubContent('https://github.com/mock-owner/mock-repo/blob/main/packages/core/index.js');
        expect(result).toBeDefined();
        expect(result).toContain('# File: `packages/core/index.js` (mock-owner/mock-repo @ main)');
        expect(result).toContain('```javascript');
        expect(result).toContain('export const hello = "world";');
        expect(mockRequest).toHaveBeenCalled();
        const calledUrl = (mockRequest.mock.calls[0][0] as { url?: string })?.url;
        expect(calledUrl).toContain('raw.githubusercontent.com/mock-owner/mock-repo/main/packages/core/index.js');
    });

    it('identifies issue URL and formats title, status, description, reactions, and comments', async () => {
        vi.spyOn(axios, 'request')
            // Issue detail response
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    number: 42,
                    title: 'Bug in state management',
                    state: 'open',
                    user: { login: 'octocat' },
                    created_at: '2026-01-01T00:00:00Z',
                    html_url: 'https://github.com/mock-owner/mock-repo/issues/42',
                    body: 'Something went wrong when updating state.',
                    comments: 1,
                    reactions: { total_count: 5, '+1': 3, heart: 2 }
                },
                headers: {}
            })
            // Comments response
            .mockResolvedValueOnce({
                status: 200,
                data: [
                    {
                        user: { login: 'maintainer' },
                        created_at: '2026-01-01T01:00:00Z',
                        body: 'Thanks for reporting, fixed in PR #43.'
                    }
                ],
                headers: {}
            });

        const result = await fetchGithubReadme('https://github.com/mock-owner/mock-repo/issues/42');
        expect(result).toBeDefined();
        expect(result).toContain('# Issue #42: Bug in state management');
        expect(result).toContain('- **Status**: OPEN');
        expect(result).toContain('@octocat');
        expect(result).toContain('**Reactions**: 👍 3 ❤️ 2');
        expect(result).toContain('Something went wrong when updating state.');
        expect(result).toContain('Discussion (1 comments)');
        expect(result).toContain('Comment 1 by @maintainer');
        expect(result).toContain('Thanks for reporting, fixed in PR #43.');
    });

    it('identifies pull request URL and formats title, branches, description, and changed files', async () => {
        vi.spyOn(axios, 'request')
            // PR detail response
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    number: 101,
                    title: 'Add new streaming feature',
                    state: 'open',
                    user: { login: 'contributor' },
                    created_at: '2026-02-01T00:00:00Z',
                    html_url: 'https://github.com/mock-owner/mock-repo/pull/101',
                    body: 'This PR implements streaming for responses.',
                    head: { ref: 'feature/stream' },
                    base: { ref: 'main' },
                    additions: 120,
                    deletions: 15,
                    changed_files: 2
                },
                headers: {}
            })
            // PR files response
            .mockResolvedValueOnce({
                status: 200,
                data: [
                    { filename: 'src/stream.ts', additions: 100, deletions: 10, status: 'added' },
                    { filename: 'src/index.ts', additions: 20, deletions: 5, status: 'modified' }
                ],
                headers: {}
            });

        const result = await fetchGithubContent('https://github.com/mock-owner/mock-repo/pull/101');
        expect(result).toBeDefined();
        expect(result).toContain('# Pull Request #101: Add new streaming feature');
        expect(result).toContain('- **Status**: OPEN');
        expect(result).toContain('- **Branch**: `feature/stream` -> `main`');
        expect(result).toContain('- **Changes**: +120 -15 across 2 files');
        expect(result).toContain('This PR implements streaming for responses.');
        expect(result).toContain('## Changed Files (2)');
        expect(result).toContain('`src/stream.ts` (+100, -10, status: added)');
    });

    it('identifies tree URL and formats ASCII directory tree', async () => {
        vi.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: {
                sha: 'abc123',
                tree: [
                    { path: 'src', type: 'tree' },
                    { path: 'src/index.ts', type: 'blob', size: 1024 },
                    { path: 'src/utils', type: 'tree' },
                    { path: 'src/utils/helpers.ts', type: 'blob', size: 2048 },
                    { path: 'package.json', type: 'blob', size: 512 }
                ]
            },
            headers: {}
        });

        const result = await fetchGithubContent('https://github.com/mock-owner/mock-repo/tree/main/src');
        expect(result).toBeDefined();
        expect(result).toContain('# Directory Tree: mock-owner/mock-repo @ main (subpath: /src)');
        expect(result).toContain('index.ts');
        expect(result).toContain('utils');
        expect(result).toContain('helpers.ts');
    });

    it('renders ASCII tree correctly with renderAsciiTree', () => {
        const items: Array<{ path: string; type: 'blob' | 'tree'; size?: number }> = [
            { path: 'docs', type: 'tree' },
            { path: 'docs/guide.md', type: 'blob', size: 1500 },
            { path: 'src', type: 'tree' },
            { path: 'src/index.ts', type: 'blob', size: 800 },
            { path: 'README.md', type: 'blob', size: 300 }
        ];

        const treeStr = renderAsciiTree(items);
        expect(treeStr).toContain('📁 docs');
        expect(treeStr).toContain('📄 guide.md (1.5 KB)');
        expect(treeStr).toContain('📁 src');
        expect(treeStr).toContain('📄 index.ts (800 B)');
        expect(treeStr).toContain('📄 README.md (300 B)');
    });
});

describe('GitHub Search Intent & Helpers', () => {
    it('accurately identifies issue intent vs repo intent', () => {
        expect(isGithubIssueIntent('react hydration error in nextjs')).toBe(true);
        expect(isGithubIssueIntent('uncaught exception crash')).toBe(true);
        expect(isGithubIssueIntent('repo:facebook/react cannot read property of undefined')).toBe(true);
        expect(isGithubIssueIntent('is:issue vite build bug')).toBe(true);

        expect(isGithubIssueIntent('zustand state management')).toBe(false);
        expect(isGithubIssueIntent('express framework')).toBe(false);
        expect(isGithubIssueIntent('hono')).toBe(false);
    });

    it('formats star counts properly', () => {
        expect(formatStars(50)).toBe('50');
        expect(formatStars(999)).toBe('999');
        expect(formatStars(1200)).toBe('1.2k');
        expect(formatStars(25000)).toBe('25k');
        expect(formatStars(1500000)).toBe('1.5M');
    });
});

describe('fetchWebContent integration with GitHub URLs', () => {
    it('transparently forwards GitHub URLs to fetchGithub in non-raw mode', async () => {
        const mockGithubFetcher = vi.fn().mockResolvedValue('# GitHub Mock Readme Content\n\nSome docs here.');
        const mockFallbackWebFetcher = vi.fn();

        const service = createWebFetchService(mockFallbackWebFetcher, {
            fetchGithub: mockGithubFetcher
        });

        const res = await service.execute({
            url: 'https://github.com/facebook/react',
            maxChars: 5000
        });

        expect(mockGithubFetcher).toHaveBeenCalledWith('https://github.com/facebook/react');
        expect(mockFallbackWebFetcher).not.toHaveBeenCalled();
        expect(res.siteName).toBe('GitHub');
        expect(res.contentType).toBe('text/markdown');
        expect(res.content).toContain('# GitHub Mock Readme Content');
    });

    it('falls back to standard webFetcher if fetchGithub returns null', async () => {
        const mockGithubFetcher = vi.fn().mockResolvedValue(null);
        const mockFallbackWebFetcher = vi.fn().mockResolvedValue({
            url: 'https://github.com/facebook/react',
            finalUrl: 'https://github.com/facebook/react',
            content: 'Web fallback html',
            totalLength: 17,
            startIndex: 0,
            truncated: false,
            retrievalMethod: 'request',
            contentType: 'text/html'
        });

        const service = createWebFetchService(mockFallbackWebFetcher, {
            fetchGithub: mockGithubFetcher
        });

        const res = await service.execute({
            url: 'https://github.com/facebook/react',
            maxChars: 5000
        });

        expect(mockGithubFetcher).toHaveBeenCalled();
        expect(mockFallbackWebFetcher).toHaveBeenCalled();
        expect(res.content).toBe('Web fallback html');
    });
});
