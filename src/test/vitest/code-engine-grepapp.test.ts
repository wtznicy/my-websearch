import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseGrepAppResponse } from '../../engines/code/grepApp.js';

// grep.app 优先走 wreq 指纹会话；测试里把它代理回 axios.request，复用现有 axios mock。
vi.mock('../../utils/impersonateRequest.js', async () => {
    const axios = (await import('axios')).default;
    return {
        impersonateHttpGet: (_engine: string, url: string, options: Record<string, unknown>) =>
            axios.request({ ...options, method: 'GET', url })
    };
});

describe('Code Search Engine (grep.app)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('parses structured search hits with repo, path, line, and snippet', () => {
        const mockApiResponse = {
            hits: {
                total: 42,
                hits: [
                    {
                        repo: { raw: 'facebook/react' },
                        path: { raw: 'packages/react/src/ReactHooks.js' },
                        line: { raw: 24 },
                        content: { snippet: 'export function <mark>useState</mark>(initialState) {' }
                    },
                    {
                        repo: { raw: 'vercel/next.js' },
                        path: { raw: 'packages/next/src/client/components/hooks.ts' },
                        line: { raw: 105 },
                        content: { snippet: 'const [state, setState] = <mark>useState</mark>(null);' }
                    }
                ]
            }
        };

        const results = parseGrepAppResponse(mockApiResponse, 5);
        expect(results).toHaveLength(2);

        expect(results[0]?.title).toBe('facebook/react: packages/react/src/ReactHooks.js#L24');
        expect(results[0]?.url).toBe('https://github.com/facebook/react/blob/master/packages/react/src/ReactHooks.js#L24');
        expect(results[0]?.engine).toBe('code');
        expect(results[0]?.repo).toBe('facebook/react');
        expect(results[0]?.path).toBe('packages/react/src/ReactHooks.js');
        expect(results[0]?.line).toBe(24);
        expect(results[0]?.description).toBe('export function useState(initialState) {');

        expect(results[1]?.title).toBe('vercel/next.js: packages/next/src/client/components/hooks.ts#L105');
        expect(results[1]?.repo).toBe('vercel/next.js');
    });

    it('parses current grep.app schema (flat repo/path/branch + HTML table snippet)', () => {
        const htmlSnippet = '<table class="highlight-table"><tr data-line="199"><td><div class="lineno">199</div></td><td><div class="highlight"><pre><span class="kd">const</span> <span class="nx"><mark class="m-l">useState</mark></span>(false);</pre></div></td></tr></table>';
        const results = parseGrepAppResponse({
            hits: {
                total: 1,
                hits: [{
                    repo: 'react/react-native',
                    branch: 'main',
                    path: 'packages/rn-tester/js/examples/ScrollView/ScrollViewExample.js',
                    content: { snippet: htmlSnippet },
                    total_matches: 1
                }]
            }
        }, 5);

        expect(results).toHaveLength(1);
        expect(results[0]?.url).toBe('https://github.com/react/react-native/blob/main/packages/rn-tester/js/examples/ScrollView/ScrollViewExample.js#L199');
        expect(results[0]?.repo).toBe('react/react-native');
        expect(results[0]?.line).toBe(199);
        expect(results[0]?.description).toContain('199: const useState(false);');
    });

    it('returns empty array when no hits are found', () => {
        const emptyResponse = { hits: { total: 0, hits: [] } };
        expect(parseGrepAppResponse(emptyResponse)).toEqual([]);
        expect(parseGrepAppResponse({})).toEqual([]);
        expect(parseGrepAppResponse(null)).toEqual([]);
    });

    it('detects bot challenge / security checkpoint', () => {
        const htmlSecurityPage = '<html><head><title>Security Checkpoint</title></head><body>Please verify...</body></html>';
        expect(() => parseGrepAppResponse(htmlSecurityPage)).toThrow(/security checkpoint/i);

        const googleSorryPage = '<html><head><title>Sorry...</title></head><body>https://www.google.com/sorry/index?continue=...</body></html>';
        expect(() => parseGrepAppResponse(googleSorryPage)).toThrow(/security checkpoint/i);
    });

    it('identifies 302 redirect to google.com/sorry as bot_challenge without following redirect', async () => {
        const { searchGrepApp } = await import('../../engines/code/grepApp.js');
        const axios = (await import('axios')).default;
        const requestSpy = (await import('vitest')).vi.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 302,
            headers: {
                location: 'https://www.google.com/sorry/index?continue=https://grep.app/api/search'
            },
            data: ''
        });

        await expect(searchGrepApp('test query', 5)).rejects.toMatchObject({
            code: 'bot_challenge',
            engine: 'code',
            retryable: false
        });

        // 验证只请求了一次 grep.app，且 maxRedirects 为 0，绝对没有向 www.google.com 发起第二次重定向请求
        expect(requestSpy).toHaveBeenCalledTimes(1);
        const callConfig = requestSpy.mock.calls[0]?.[0];
        expect(callConfig?.maxRedirects).toBe(0);
        expect(callConfig?.url).toContain('https://grep.app/api/search');
    });

    it('classifies Vercel 429 challenge as bot_challenge without retry', async () => {
        const { searchGrepApp } = await import('../../engines/code/grepApp.js');
        const axios = (await import('axios')).default;
        vi.spyOn(axios, 'request').mockRejectedValueOnce(Object.assign(
            new Error('Request failed with status code 429'),
            { response: { status: 429, headers: { 'x-vercel-mitigated': 'challenge' } } }
        ));

        await expect(searchGrepApp('test query', 5)).rejects.toMatchObject({
            code: 'bot_challenge',
            engine: 'code',
            retryable: false
        });
    });

    it('classifies plain 429 as rate_limited and retryable', async () => {
        const { searchGrepApp } = await import('../../engines/code/grepApp.js');
        const axios = (await import('axios')).default;
        vi.spyOn(axios, 'request').mockRejectedValueOnce(Object.assign(
            new Error('Request failed with status code 429'),
            { response: { status: 429, headers: {} } }
        ));

        await expect(searchGrepApp('test query', 5)).rejects.toMatchObject({
            code: 'rate_limited',
            engine: 'code',
            retryable: true
        });
    });
});
