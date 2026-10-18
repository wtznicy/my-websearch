import { describe, it, expect } from 'vitest';
import { parseGrepAppResponse } from '../../engines/code/grepApp.js';

describe('Code Search Engine (grep.app)', () => {
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

    it('returns empty array when no hits are found', () => {
        const emptyResponse = { hits: { total: 0, hits: [] } };
        expect(parseGrepAppResponse(emptyResponse)).toEqual([]);
        expect(parseGrepAppResponse({})).toEqual([]);
        expect(parseGrepAppResponse(null)).toEqual([]);
    });

    it('detects bot challenge / security checkpoint', () => {
        const htmlSecurityPage = '<html><head><title>Security Checkpoint</title></head><body>Please verify...</body></html>';
        expect(() => parseGrepAppResponse(htmlSecurityPage)).toThrow(/security checkpoint/i);
    });
});
