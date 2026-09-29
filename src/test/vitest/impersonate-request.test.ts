import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { impersonateHttpGet, __setEngineSessionForTests } from '../../utils/impersonateRequest.js';
import type { WreqSession } from '../../engines/bing/impersonate.js';

describe('impersonateHttpGet silent retry', () => {
    afterEach(() => {
        __setEngineSessionForTests('test-engine', null);
        vi.restoreAllMocks();
    });

    it('should return on first fetch when successful', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            status: 200,
            headers: {
                get: (k: string) => (k === 'content-type' ? 'text/plain' : null),
                forEach: () => undefined
            },
            text: async () => 'hello world'
        });

        const mockSession = {
            fetch: mockFetch,
            getAllCookies: () => [],
            setCookie: () => undefined,
            close: async () => undefined
        } as unknown as WreqSession;

        __setEngineSessionForTests('test-engine', mockSession);

        const res = await impersonateHttpGet('test-engine', 'https://example.com/test', {});
        expect(res.status).toBe(200);
        expect(res.data).toBe('hello world');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should silently retry once when encountering unexpected EOF and succeed', async () => {
        const mockFetch = vi.fn()
            .mockRejectedValueOnce(new Error('client error (Connect): unexpected EOF'))
            .mockResolvedValueOnce({
                status: 200,
                headers: {
                    get: (k: string) => (k === 'content-type' ? 'application/json' : null),
                    forEach: () => undefined
                },
                text: async () => JSON.stringify({ ok: true })
            });

        const mockSession = {
            fetch: mockFetch,
            getAllCookies: () => [],
            setCookie: () => undefined,
            close: async () => undefined
        } as unknown as WreqSession;

        __setEngineSessionForTests('test-engine', mockSession);

        const axiosGetSpy = vi.spyOn(axios, 'get');

        const res = await impersonateHttpGet('test-engine', 'https://example.com/test', {});
        expect(res.status).toBe(200);
        expect(res.data).toBe(JSON.stringify({ ok: true }));
        expect(mockFetch).toHaveBeenCalledTimes(2);
        // Did not fall back to axios because retry succeeded
        expect(axiosGetSpy).not.toHaveBeenCalled();
    });

    it('should silently retry on ECONNRESET and succeed', async () => {
        const mockFetch = vi.fn()
            .mockRejectedValueOnce(new Error('read ECONNRESET'))
            .mockResolvedValueOnce({
                status: 200,
                headers: {
                    get: () => null,
                    forEach: () => undefined
                },
                text: async () => 'recovered'
            });

        const mockSession = {
            fetch: mockFetch,
            getAllCookies: () => [],
            setCookie: () => undefined,
            close: async () => undefined
        } as unknown as WreqSession;

        __setEngineSessionForTests('test-engine', mockSession);

        const res = await impersonateHttpGet('test-engine', 'https://example.com/test', {});
        expect(res.status).toBe(200);
        expect(res.data).toBe('recovered');
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should invalidate session and fall back to axios if retry also fails', async () => {
        const mockClose = vi.fn().mockResolvedValue(undefined);
        const mockFetch = vi.fn()
            .mockRejectedValueOnce(new Error('client error (Connect): unexpected EOF'))
            .mockRejectedValueOnce(new Error('client error (Connect): unexpected EOF'));

        const mockSession = {
            fetch: mockFetch,
            getAllCookies: () => [],
            setCookie: () => undefined,
            close: mockClose
        } as unknown as WreqSession;

        __setEngineSessionForTests('test-engine', mockSession);

        const axiosGetSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
            status: 200,
            data: 'from-axios',
            headers: {},
            config: {},
            statusText: 'OK'
        } as never);

        const res = await impersonateHttpGet('test-engine', 'https://example.com/test', {});
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(axiosGetSpy).toHaveBeenCalledTimes(1);
        expect(res.data).toBe('from-axios');
    });

    it('should not retry on HTTP 429 rate limit and directly throw without falling back to axios', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            status: 429,
            headers: {
                get: () => null,
                forEach: () => undefined
            },
            text: async () => 'Too Many Requests'
        });

        const mockSession = {
            fetch: mockFetch,
            getAllCookies: () => [],
            setCookie: () => undefined,
            close: async () => undefined
        } as unknown as WreqSession;

        __setEngineSessionForTests('test-engine', mockSession);

        const axiosGetSpy = vi.spyOn(axios, 'get');

        await expect(impersonateHttpGet('test-engine', 'https://example.com/test', {}))
            .rejects
            .toThrow('Request failed with status code 429');

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(axiosGetSpy).not.toHaveBeenCalled();
    });
});
