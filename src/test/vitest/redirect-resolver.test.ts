import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import {
    extractMetaOrJsRedirect,
    resolveHttpRedirectUrl,
    resolveBatchRedirects
} from '../../utils/redirectResolver.js';

describe('redirectResolver', () => {
    describe('extractMetaOrJsRedirect', () => {
        it('returns null for empty or non-redirecting HTML', () => {
            expect(extractMetaOrJsRedirect('')).toBeNull();
            expect(extractMetaOrJsRedirect('<html><body>Hello</body></html>')).toBeNull();
        });

        it('extracts target from window.location.replace', () => {
            const html = `<html><head><script>window.location.replace("https://example.com/dest?q=1");</script></head></html>`;
            expect(extractMetaOrJsRedirect(html)).toBe('https://example.com/dest?q=1');
        });

        it('extracts target from meta refresh tag', () => {
            const html = `<html><head><meta http-equiv="refresh" content="0;URL='https://example.org/landing'"></head></html>`;
            expect(extractMetaOrJsRedirect(html)).toBe('https://example.org/landing');
        });

        it('ignores relative or javascript: targets', () => {
            const html = `<script>window.location.replace("/relative/path")</script>`;
            expect(extractMetaOrJsRedirect(html)).toBeNull();
        });
    });

    describe('resolveHttpRedirectUrl', () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('resolves final URL from axios responseUrl', async () => {
            vi.spyOn(axios, 'head').mockResolvedValue({
                request: {
                    res: {
                        responseUrl: 'https://final.destination.com/page'
                    }
                }
            } as any);

            const result = await resolveHttpRedirectUrl('https://short.link/xyz');
            expect(result).toBe('https://final.destination.com/page');
        });

        it('resolves from location header if responseUrl is missing', async () => {
            vi.spyOn(axios, 'head').mockResolvedValue({
                request: {
                    res: {
                        headers: {
                            location: 'https://header.destination.com/target'
                        }
                    }
                }
            } as any);

            const result = await resolveHttpRedirectUrl('https://short.link/abc');
            expect(result).toBe('https://header.destination.com/target');
        });

        it('gracefully falls back to original URL on network/HTTP error', async () => {
            vi.spyOn(axios, 'head').mockRejectedValue(new Error('Connection timeout'));

            const result = await resolveHttpRedirectUrl('https://failing.link/err');
            expect(result).toBe('https://failing.link/err');
        });
    });

    describe('resolveBatchRedirects', () => {
        it('resolves batch with concurrency budget and returns resolved URLs', async () => {
            const urls = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3'];
            const resolver = vi.fn(async (url: string) => url.replace('a.com', 'b.com'));

            const results = await resolveBatchRedirects(urls, resolver, { concurrency: 2, budgetMs: 1000 });
            expect(results).toEqual([
                'https://b.com/1',
                'https://b.com/2',
                'https://b.com/3'
            ]);
            expect(resolver).toHaveBeenCalledTimes(3);
        });

        it('falls back to original url if resolver throws', async () => {
            const urls = ['https://ok.com', 'https://fail.com'];
            const resolver = vi.fn(async (url: string) => {
                if (url.includes('fail')) throw new Error('fail');
                return 'https://resolved.ok.com';
            });

            const results = await resolveBatchRedirects(urls, resolver);
            expect(results).toEqual(['https://resolved.ok.com', 'https://fail.com']);
        });
    });
});
