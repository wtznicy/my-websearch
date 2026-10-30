import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { parseGitHubRepoSpec, searchGithub } from '../../engines/github/githubSearch.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('parseGitHubRepoSpec', () => {
    it('parses owner/repo and common GitHub URLs', () => {
        expect(parseGitHubRepoSpec('facebook/react')).toEqual({ owner: 'facebook', repo: 'react' });
        expect(parseGitHubRepoSpec('https://github.com/facebook/react')).toEqual({ owner: 'facebook', repo: 'react' });
        expect(parseGitHubRepoSpec('https://github.com/facebook/react/tree/main/packages')).toEqual({ owner: 'facebook', repo: 'react' });
        expect(parseGitHubRepoSpec('github.com/facebook/react.git')).toEqual({ owner: 'facebook', repo: 'react' });
    });

    it('does not treat normal queries or qualifiers as exact repos', () => {
        expect(parseGitHubRepoSpec('react hydration mismatch')).toBeNull();
        expect(parseGitHubRepoSpec('repo:facebook/react')).toBeNull();
        expect(parseGitHubRepoSpec('facebook/')).toBeNull();
        expect(parseGitHubRepoSpec('https://github.com/facebook')).toBeNull();
    });
});

describe('searchGithub exact repository fast path', () => {
    it('returns the exact repository for limit=1 without calling Search API', async () => {
        const originalToken = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;
        try {
            const request = vi.spyOn(axios, 'request').mockResolvedValueOnce({
                status: 200,
                data: {
                    full_name: 'facebook/react',
                    html_url: 'https://github.com/facebook/react',
                    description: 'The library for web and native user interfaces.',
                    stargazers_count: 230000,
                    language: 'JavaScript',
                    updated_at: '2026-10-01T00:00:00Z'
                },
                headers: {}
            });

            const results = await searchGithub('facebook/react', 1);

            expect(results).toHaveLength(1);
            expect(results[0].title).toBe('facebook/react');
            expect(results[0].url).toBe('https://github.com/facebook/react');
            expect(results[0].description).toContain('★230000');
            expect(results[0].description).toContain('[JavaScript]');
            expect(request).toHaveBeenCalledTimes(1);
            expect(String(request.mock.calls[0]?.[0]?.url)).toContain('/repos/facebook/react');
        } finally {
            if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken;
        }
    });
});
