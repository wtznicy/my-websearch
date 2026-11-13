import { describe, it, expect } from 'vitest';
import { requireFlagValue, commandNeedsRuntime } from '../../cli/runCli.js';
import { parseSearchArgs } from '../../cli/commands/search.js';
import { parseFetchWebArgs } from '../../cli/commands/fetchWeb.js';
import { parseFetchGithubArgs } from '../../cli/commands/fetchGithub.js';
import { parseResolveLibraryArgs, parseQueryDocsArgs, formatQueryDocsHumanReadable } from '../../cli/commands/docs.js';
import { parseStatusArgs } from '../../cli/commands/status.js';
import { parseServeArgs } from '../../cli/commands/serve.js';
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
            expect(commandNeedsRuntime(['resolve-library-id', 'next.js'])).toBe(true);
            expect(commandNeedsRuntime(['query-docs', '/vercel/next.js'])).toBe(true);
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

        it('parses --time-range and rejects invalid values', () => {
            const parsed = parseSearchArgs(['typescript', 'release', '--time-range', 'week'], mockRuntime);
            expect(parsed.timeRange).toBe('week');
            expect(() => parseSearchArgs(['test', '--time-range', 'yesterday'], mockRuntime))
                .toThrow('--time-range must be one of: day, week, month, year');
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

        it('parses --site, --fetch-top, --format, and --queries', () => {
            const parsed = parseSearchArgs(['tokio', '--site', 'tokio.rs,docs.rs', '--fetch-top', '2', '--format', 'markdown', '--queries', 'q1,q2'], mockRuntime);
            expect(parsed.site).toEqual(['tokio.rs', 'docs.rs']);
            expect(parsed.fetchTop).toBe(2);
            expect(parsed.format).toBe('markdown');
            expect(parsed.queries).toEqual(['q1', 'q2']);
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
            const parsed = parseFetchWebArgs(['https://example.com', '--max-chars', '5000', '--readability', '--format', 'markdown', '--json']);
            expect(parsed.url).toBe('https://example.com');
            expect(parsed.maxChars).toBe(5000);
            expect(parsed.readability).toBe(true);
            expect(parsed.format).toBe('markdown');
            expect(parsed.json).toBe(true);
        });

        it('throws if URL is missing', () => {
            expect(() => parseFetchWebArgs(['--json'])).toThrow('Target URL is required');
        });

        it('throws if maxChars is invalid', () => {
            expect(() => parseFetchWebArgs(['https://example.com', '--max-chars', '50'])).toThrow('maxChars must be an integer between 100 and 200000');
        });

        it('throws if format is invalid', () => {
            expect(() => parseFetchWebArgs(['https://example.com', '--format', 'xml'])).toThrow('format must be one of: text, markdown');
        });
    });

    describe('parseFetchGithubArgs', () => {
        it('parses valid repository URL and options', () => {
            const parsed = parseFetchGithubArgs([
                'https://github.com/expressjs/express',
                '--symbol', 'Router',
                '--lines', '10-20',
                '--ref', 'master',
                '--max-results', '10',
                '--release-limit', '5',
                '--json'
            ]);
            expect(parsed.url).toBe('https://github.com/expressjs/express');
            expect(parsed.symbol).toBe('Router');
            expect(parsed.lines).toBe('10-20');
            expect(parsed.ref).toBe('master');
            expect(parsed.maxResults).toBe(10);
            expect(parsed.releaseLimit).toBe(5);
            expect(parsed.json).toBe(true);
        });

        it('throws if URL is missing', () => {
            expect(() => parseFetchGithubArgs(['--json'])).toThrow('Target URL is required');
        });
    });

    describe('parseResolveLibraryArgs', () => {
        it('parses valid resolve-library-id arguments', () => {
            const parsed = parseResolveLibraryArgs(['next.js', '--query', 'middleware auth', '--limit', '3', '--json']);
            expect(parsed.libraryName).toBe('next.js');
            expect(parsed.query).toBe('middleware auth');
            expect(parsed.limit).toBe(3);
            expect(parsed.json).toBe(true);
        });

        it('throws if libraryName is missing', () => {
            expect(() => parseResolveLibraryArgs(['--limit', '5'])).toThrow('libraryName is required');
        });

        it('throws if limit is out of range', () => {
            expect(() => parseResolveLibraryArgs(['next.js', '--limit', '0'])).toThrow('Limit must be an integer between 1 and 10');
            expect(() => parseResolveLibraryArgs(['next.js', '--limit', '20'])).toThrow('Limit must be an integer between 1 and 10');
        });
    });

    describe('parseQueryDocsArgs', () => {
        it('parses valid query-docs arguments', () => {
            const parsed = parseQueryDocsArgs(['/vercel/next.js', '--query', 'app router', '--limit', '5', '--json']);
            expect(parsed.libraryId).toBe('/vercel/next.js');
            expect(parsed.query).toBe('app router');
            expect(parsed.limit).toBe(5);
            expect(parsed.json).toBe(true);
        });

        it('accepts library without leading slash', () => {
            const parsed = parseQueryDocsArgs(['vercel/next.js', '--query', 'app router']);
            expect(parsed.libraryId).toBe('vercel/next.js');
        });

        it('parses --source and --version options', () => {
            const parsed = parseQueryDocsArgs(['devdocs:redis', '--source', 'devdocs', '--version', '7.0', '--query', 'hset']);
            expect(parsed.libraryId).toBe('devdocs:redis');
            expect(parsed.source).toBe('devdocs');
            expect(parsed.version).toBe('7.0');
            expect(parsed.query).toBe('hset');
        });

        it('throws if libraryId is missing', () => {
            expect(() => parseQueryDocsArgs(['--limit', '5'])).toThrow('libraryId is required');
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

    describe('formatQueryDocsHumanReadable', () => {
        it('renders content, readme, documentationUrl and repositoryUrl properly', () => {
            const formatted = formatQueryDocsHumanReadable({
                libraryId: 'left-pad',
                source: 'npm',
                documentationUrl: 'https://www.npmjs.com/package/left-pad',
                repositoryUrl: 'https://github.com/stevemao/left-pad',
                content: '## API\n\nleftPad(str, len, [ch])',
                readme: '# left-pad\n\nString left padding.'
            });

            expect(formatted).toContain('Documentation for left-pad [npm]:');
            expect(formatted).toContain('URL: https://www.npmjs.com/package/left-pad');
            expect(formatted).toContain('Repository: https://github.com/stevemao/left-pad');
            expect(formatted).toContain('leftPad(str, len, [ch])');
            expect(formatted).toContain('String left padding.');
        });
    });
});
