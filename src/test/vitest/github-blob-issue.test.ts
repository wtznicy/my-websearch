import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchGithubReadme, __resetGithubReadmeCacheForTests } from '../../engines/github/github.js';
import axios from 'axios';

describe('fetchGithubReadme extended capabilities (blob files & issues)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        __resetGithubReadmeCacheForTests();
    });

    it('identifies blob URL and fetches raw source file content', async () => {
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

        const result = await fetchGithubReadme('https://github.com/mock-owner/mock-repo/blob/main/packages/core/index.js');
        expect(result).toBe('export const hello = "world";');
        expect(mockRequest).toHaveBeenCalled();
        const calledUrl = (mockRequest.mock.calls[0][0] as { url?: string })?.url;
        expect(calledUrl).toContain('raw.githubusercontent.com/mock-owner/mock-repo/main/packages/core/index.js');
    });

    it('identifies issue URL and formats title, status, description, and comments', async () => {
        const mockRequest = vi.spyOn(axios, 'request')
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
                    comments: 1
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
        expect(result).toContain('Something went wrong when updating state.');
        expect(result).toContain('Discussion (1 comments)');
        expect(result).toContain('Comment 1 by @maintainer');
        expect(result).toContain('Thanks for reporting, fixed in PR #43.');
    });
});
