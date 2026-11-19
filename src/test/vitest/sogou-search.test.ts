import { describe, it, expect, afterEach } from 'vitest';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { __setSogouHttpGetForTests, parseSogouSearchResults, parseSogouMobileResults, resetSogouState, searchSogou } from '../../engines/sogou/sogou.js';

function makeResponse(status: number, headers: Record<string, string | string[]>, data: string): AxiosResponse {
    return {
        status,
        statusText: String(status),
        headers,
        data,
        config: {} as AxiosResponse['config']
    };
}

afterEach(() => {
    __setSogouHttpGetForTests();
    resetSogouState();
});

describe('Sogou search', () => {
    it('skips duplicates, missing and script URLs while decoding redirect targets', () => {
        const html = `
            <div id="main">
              <div class="vrwrap">
                <h3 class="vr-title"><a href="https://example.com/my-websearch"> MyWebSearch </a></h3>
                <div class="str_info"> MCP server and CLI search demo. </div>
                <cite>example.com</cite>
              </div>
              <div class="vrwrap">
                <h3 class="vr-title"><a href="/link?url=https%3A%2F%2Fdocs.example.com%2Fguide"> Docs Guide </a></h3>
                <p> Project documentation and setup guide. </p>
              </div>
              <div class="vrwrap">
                <h3 class="vr-title"><a href="https://example.com/my-websearch"> Duplicate </a></h3>
                <div class="str_info">Duplicate should be skipped.</div>
              </div>
              <div class="vrwrap"><h3 class="vr-title"><a href=""> Missing URL </a></h3></div>
              <div class="vrwrap"><h3 class="vr-title"><a href="javascript:void(0)"> Script URL </a></h3></div>
            </div>`;

        const results = parseSogouSearchResults(html);
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            title: 'MyWebSearch',
            url: 'https://example.com/my-websearch',
            description: 'MCP server and CLI search demo.',
            source: 'example.com',
            engine: 'sogou'
        });
        expect(results[1].title).toBe('Docs Guide');
        expect(results[1].url).toBe('https://docs.example.com/guide');
        expect(results[1].source).toBe('docs.example.com');
    });

    it('follows a redirect and carries the Sogou cookie to the next hop', async () => {
        const requestedUrls: string[] = [];
        const requestedCookies: Array<string | undefined> = [];

        __setSogouHttpGetForTests(async (url: string, options: AxiosRequestConfig) => {
            if (url.includes('m.sogou.com')) {
                return makeResponse(200, {}, '<html><body>no results</body></html>');
            }
            requestedUrls.push(url);
            requestedCookies.push((options.headers as Record<string, string> | undefined)?.Cookie);

            if (requestedUrls.length === 1) {
                return makeResponse(
                    302,
                    {
                        location: '/web?query=%E5%8C%97%E4%BA%AC&page=1&ie=utf8',
                        'set-cookie': ['SNUID=test-cookie; path=/']
                    },
                    ''
                );
            }
            return makeResponse(
                200,
                {},
                `<div id="main"><div class="vrwrap">
                    <h3 class="vr-title"><a href="https://example.com/beijing">Beijing</a></h3>
                    <div class="str_info">Capital city.</div>
                </div></div>`
            );
        });

        const results = await searchSogou('北京', 1);
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('Beijing');
        expect(requestedUrls).toHaveLength(2);
        expect(requestedUrls[0].startsWith('https://www.sogou.com/web?')).toBe(true);
        expect(requestedCookies[1]).toContain('SNUID=test-cookie');
    });

    it('extracts results from both legacy .vrResult and modern .reactResult mobile containers', () => {
        const html = `
            <div id="results">
              <div class="vrResult">
                <a class="resultLink" href="./tc?url=https%3A%2F%2Fexample.com%2Flegacy">
                  <h3>Legacy Result</h3>
                </a>
                <div class="text-layout">Legacy snippet description</div>
              </div>
              <div class="reactResult" id="sogou_vr_30010582_1">
                <a class="title__saTitle_287f" href="./tc?url=https%3A%2F%2Fexample.com%2Freact-item">
                  <h3>React/SSR Modern Result</h3>
                </a>
                <p>Modern snippet description</p>
              </div>
              <!-- Hidden suggestion topic container should be skipped -->
              <div class="vrResult vr-topic" style="display:none">
                <a href="./tc?url=https%3A%2F%2Fexample.com%2Fskip">
                  <h3>Should be skipped</h3>
                </a>
              </div>
            </div>`;

        const results = parseSogouMobileResults(html);
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            title: 'Legacy Result',
            url: 'https://example.com/legacy',
            description: 'Legacy snippet description',
            source: 'example.com',
            engine: 'sogou'
        });
        expect(results[1]).toMatchObject({
            title: 'React/SSR Modern Result',
            url: 'https://example.com/react-item',
            description: 'Modern snippet description',
            source: 'example.com',
            engine: 'sogou'
        });
    });
});
