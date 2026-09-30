import { describe, it, expect } from 'vitest';
import {
    requireFlagValue,
    commandNeedsRuntime,
    parseSearchArgs,
    parseFetchWebArgs,
    parseFetchGithubArgs,
    parseStatusArgs,
    parseServeArgs
} from '../../cli/runCli.js';
import type { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';

describe('runCli argument parsing', () => {
    const mockRuntime = {
        config: {
            defaultSearchEngine: 'bing',
            allowedSearchEngines: ['bing', 'google', 'duckduckgo', 'baidu', 'sogou']
        }
    } as unknown as MyWebSearchRuntime;

    describe('requireFlagValue', () => {
        it('returns value following flag', () => {
            expect(requireFlagValue(['--limit', '20'], 0, '--limit')).toBe('20');
        });

        it('throws error if next argument is missing or another flag', () => {
            expect(() => requireFlagValue(['--limit'], 0, '--limit')).toThrow('Missing value for --limit');
            expect(() => requireFlagValue(['--limit', '--json'], 0, '--limit')).toThrow('Missing value for --limit');
        });
    });

    describe('commandNeedsRuntime', () => {
        it('identifies runtime-dependent commands', () => {
            expect(commandNeedsRuntime(['search', 'query'])).toBe(true);
            expect(commandNeedsRuntime(['fetch-web', 'https://example.com'])).toBe(true);
            expect(commandNeedsRuntime(['serve'])).toBe(true);
            expect(commandNeedsRuntime(['status'])).toBe(false);
            expect(commandNeedsRuntime(['--help'])).toBe(false);
        });
    });

    describe('parseSearchArgs', () => {
        it('parses valid search query and flags', () => {
            const parsed = parseSearchArgs(['hello', 'world', '--limit', '15', '--engine', 'baidu', '--json'], mockRuntime);
            expect(parsed.query).toBe('hello world');
            expect(parsed.limit).toBe(15);
            expect(parsed.engines).toEqual(['baidu']);
            expect(parsed.json).toBe(true);
        });

        it('parses --engines comma separated', () => {
            const parsed = parseSearchArgs(['test', '--engines', 'bing,baidu'], mockRuntime);
            expect(parsed.engines).toEqual(['bing', 'baidu']);
        });

        it('routes engines automatically when defaultSearchEngine is auto and no engines specified', () => {
            const autoRuntime = {
                config: {
                    defaultSearchEngine: 'auto',
                    allowedSearchEngines: ['bing', 'duckduckgo', 'baidu', 'sogou']
                }
            } as unknown as MyWebSearchRuntime;

            const enParsed = parseSearchArgs(['typescript', 'satisfies'], autoRuntime);
            expect(enParsed.engines).toEqual(['bing', 'duckduckgo']);

            const zhParsed = parseSearchArgs(['中文搜索测试'], autoRuntime);
            expect(zhParsed.engines).toEqual(['baidu', 'sogou']);
        });

        it('expands --engine auto to routed engines', () => {
            const autoRuntime = {
                config: {
                    defaultSearchEngine: 'auto',
                    allowedSearchEngines: ['bing', 'duckduckgo', 'baidu', 'sogou']
                }
            } as unknown as MyWebSearchRuntime;

            const parsed = parseSearchArgs(['hello', '--engine', 'auto'], autoRuntime);
            expect(parsed.engines).toEqual(['bing', 'duckduckgo']);
        });

        it('throws if query is missing', () => {
            expect(() => parseSearchArgs(['--limit', '10'], mockRuntime)).toThrow('Search query is required');
        });

        it('throws if limit is out of range', () => {
            expect(() => parseSearchArgs(['test', '--limit', '0'], mockRuntime)).toThrow('Limit must be an integer between 1 and 50');
            expect(() => parseSearchArgs(['test', '--limit', '100'], mockRuntime)).toThrow('Limit must be an integer between 1 and 50');
        });
    });

    describe('parseFetchWebArgs', () => {
        it('parses valid fetch-web arguments', () => {
            const parsed = parseFetchWebArgs(['https://example.com', '--max-chars', '5000', '--readability', '--json']);
            expect(parsed.url).toBe('https://example.com');
            expect(parsed.maxChars).toBe(5000);
            expect(parsed.readability).toBe(true);
            expect(parsed.json).toBe(true);
        });

        it('throws if URL is missing', () => {
            expect(() => parseFetchWebArgs(['--json'])).toThrow('Target URL is required');
        });

        it('throws if maxChars is invalid', () => {
            expect(() => parseFetchWebArgs(['https://example.com', '--max-chars', '50'])).toThrow('maxChars must be an integer between 100 and 200000');
        });
    });

    describe('parseStatusArgs', () => {
        it('parses status args and strips trailing slashes', () => {
            const parsed = parseStatusArgs(['--base-url', 'http://localhost:3210///', '--json']);
            expect(parsed.baseUrl).toBe('http://localhost:3210');
            expect(parsed.json).toBe(true);
        });

        it('throws if unexpected positional arguments exist', () => {
            expect(() => parseStatusArgs(['unexpected'])).toThrow('Unexpected positional argument: unexpected');
        });
    });

    describe('parseServeArgs', () => {
        it('parses serve host and port', () => {
            const parsed = parseServeArgs(['--host', '0.0.0.0', '--port', '8080']);
            expect(parsed.host).toBe('0.0.0.0');
            expect(parsed.port).toBe(8080);
            expect(parsed.json).toBe(false);
        });

        it('throws if port is out of range', () => {
            expect(() => parseServeArgs(['--port', '70000'])).toThrow('Port must be an integer between 0 and 65535');
        });
    });
});
