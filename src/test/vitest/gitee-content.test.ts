import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { fetchGithubContent } from '../../engines/github/github.js';

describe('Gitee content parity (blob / tree / issue / PR)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reads a Gitee source file through the contents API and formats it as a code block', async () => {
        const encoded = Buffer.from('export const answer = 42;\n').toString('base64');
        const requestSpy = vi.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: { type: 'file', encoding: 'base64', name: 'answer.ts', path: 'src/answer.ts', content: encoded },
            headers: {}
        });

        const result = await fetchGithubContent('https://gitee.com/mock-owner/mock-repo/blob/main/src/answer.ts');

        expect(result).toContain('# File: `src/answer.ts` (mock-owner/mock-repo @ main)');
        expect(result).toContain('```typescript');
        expect(result).toContain('export const answer = 42;');
        const callConfig = requestSpy.mock.calls[0]?.[0] as { url?: string } | undefined;
        expect(callConfig?.url).toContain('gitee.com/api/v5/repos/mock-owner/mock-repo/contents/src/answer.ts');
    });

    it('renders a Gitee subtree without the self-referencing directory entry', async () => {
        vi.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: {
                tree: [
                    { path: 'src', type: 'tree' },
                    { path: 'src/a.ts', type: 'blob', size: 12 },
                    { path: 'src/b.ts', type: 'blob', size: 34 }
                ]
            },
            headers: {}
        });

        const result = await fetchGithubContent('https://gitee.com/mock-owner/mock-repo/tree/main/src');

        expect(result).toContain('# Directory Tree: mock-owner/mock-repo @ main (subpath: /src)');
        expect(result).toContain('Total items: 2');
        expect(result).toContain('a.ts');
        expect(result).toContain('(12 B)');
        expect(result).not.toContain('src/core');
    });

    it('formats a Gitee issue with description, labels, and comments', async () => {
        vi.spyOn(axios, 'request')
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    number: 'IABC123',
                    title: '启动失败',
                    state: 'open',
                    user: { login: 'alice' },
                    created_at: '2026-01-02T03:04:05+08:00',
                    html_url: 'https://gitee.com/mock-owner/mock-repo/issues/IABC123',
                    body: '复现步骤...',
                    comments: 1,
                    labels: [{ name: 'bug' }]
                },
                headers: {}
            })
            .mockResolvedValueOnce({
                status: 200,
                data: [{ user: { login: 'dev' }, created_at: '2026-01-02T04:00:00+08:00', body: '已修复' }],
                headers: {}
            });

        const result = await fetchGithubContent('https://gitee.com/mock-owner/mock-repo/issues/IABC123');

        expect(result).toContain('# Issue #IABC123: 启动失败');
        expect(result).toContain('- **Status**: OPEN');
        expect(result).toContain('- **Author**: @alice');
        expect(result).toContain('- **Labels**: bug');
        expect(result).toContain('## Description');
        expect(result).toContain('复现步骤...');
        expect(result).toContain('## Discussion (1 comments)');
        expect(result).toContain('### Comment 1 by @dev');
        expect(result).toContain('已修复');
    });

    it('formats a Gitee pull request with branch, change totals, and changed files', async () => {
        vi.spyOn(axios, 'request')
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    number: 7,
                    title: 'Fix streaming',
                    state: 'merged',
                    user: { login: 'bob' },
                    created_at: '2026-02-01T00:00:00+08:00',
                    html_url: 'https://gitee.com/mock-owner/mock-repo/pulls/7',
                    body: '修复流式响应',
                    head: { ref: 'feat/stream' },
                    base: { ref: 'main' },
                    merged_at: '2026-02-02T00:00:00+08:00'
                },
                headers: {}
            })
            .mockResolvedValueOnce({
                status: 200,
                data: [
                    { filename: 'src/stream.ts', additions: '5', deletions: '1', status: null },
                    { filename: 'src/index.ts', additions: '2', deletions: '0', status: 'modified' }
                ],
                headers: {}
            });

        const result = await fetchGithubContent('https://gitee.com/mock-owner/mock-repo/pulls/7');

        expect(result).toContain('# Pull Request #7: Fix streaming');
        expect(result).toContain('- **Status**: MERGED (merged: 2026-02-02T00:00:00+08:00)');
        expect(result).toContain('- **Branch**: `feat/stream` -> `main`');
        expect(result).toContain('- **Changes**: +7 -1 across 2 files');
        expect(result).toContain('## Changed Files (2 of 2)');
        expect(result).toContain('`src/stream.ts` (+5, -1)');
        expect(result).toContain('`src/index.ts` (+2, -0, status: modified)');
    });
});
