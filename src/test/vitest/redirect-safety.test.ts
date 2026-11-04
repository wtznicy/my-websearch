import { describe, it, expect, afterEach } from 'vitest';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { __setAxiosRequestForTests, requestWithSafeRedirects } from '../../utils/httpRequest.js';

type CannedResponse = {
    status: number;
    location?: string;
    data?: unknown;
};

function makeResponse(config: AxiosRequestConfig, canned: CannedResponse): AxiosResponse {
    const headers: Record<string, string> = {};
    if (canned.location) {
        headers.location = canned.location;
    }
    return {
        status: canned.status,
        statusText: '',
        headers,
        data: canned.data ?? '',
        config,
        request: { res: {} }
    } as AxiosResponse;
}

function stubAxios(responses: Record<string, CannedResponse>): void {
    __setAxiosRequestForTests(async (config) => {
        const canned = config.url ? responses[config.url] : undefined;
        if (!canned) {
            throw new Error(`unexpected URL: ${config.url}`);
        }
        return makeResponse(config, canned);
    });
}

afterEach(() => {
    __setAxiosRequestForTests();
});

describe('requestWithSafeRedirects', () => {
    it.each([
        ['http://127.0.0.1/admin', 'literal private IPv4'],
        ['http://[::1]:8080/secret', 'bracketed IPv6 loopback'],
        ['http://169.254.169.254/latest/meta-data/', 'IMDS'],
        ['http://127.0.0.1.nip.io/admin', 'wildcard DNS resolving to loopback']
    ])('rejects redirect to private target: %s (%s)', async (location) => {
        stubAxios({ 'http://8.8.8.8/': { status: 302, location } });
        await expect(requestWithSafeRedirects('GET', 'http://8.8.8.8/', {}))
            .rejects.toThrow(/private or local network|wildcard DNS|rebinding/i);
    });

    it('follows a public redirect and tracks the final responseUrl', async () => {
        stubAxios({
            'http://8.8.8.8/': { status: 302, location: 'http://1.1.1.1/' },
            'http://1.1.1.1/': { status: 200, data: 'ok' }
        });
        const response = await requestWithSafeRedirects('GET', 'http://8.8.8.8/', {});
        expect(response.status).toBe(200);
        expect(response.data).toBe('ok');
        expect(response.request?.res?.responseUrl).toBe('http://1.1.1.1/');
    });

    it('rejects chains exceeding maxRedirects', async () => {
        __setAxiosRequestForTests(async (config) => makeResponse(config, { status: 302, location: 'http://1.1.1.1/' }));
        await expect(requestWithSafeRedirects('GET', 'http://8.8.8.8/', { maxRedirects: 2 }))
            .rejects.toThrow(/Too many redirects/);
    });

    it('resolves a relative Location header against the current URL', async () => {
        stubAxios({
            'http://8.8.8.8/a': { status: 302, location: '/b' },
            'http://8.8.8.8/b': { status: 200, data: 'relative-ok' }
        });
        const response = await requestWithSafeRedirects('GET', 'http://8.8.8.8/a', {});
        expect(response.data).toBe('relative-ok');
    });
});
