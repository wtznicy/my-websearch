import { describe, expect, it, vi } from 'vitest';
import {
    BLOCKED_FILE_EXTENSIONS,
    BLOCKED_RESOURCE_TYPES,
    BLOCKED_TRACKER_DOMAINS,
    installBrowserResourceBlocker,
    isBlockedBrowserSubresource,
    isTrackerHost,
    RESOURCE_BLOCKER_INSTALLED
} from '../../utils/browserResourceBlocker.js';
import {
    fetchPageHtmlWithBrowser,
    getBrowserCookieHeader,
    isBlockedBrowserSubresource as exportedIsBlocked
} from '../../utils/browserCookies.js';

describe('Browser Resource Blocker (Scrapling Parity)', () => {
    describe('Re-export consistency', () => {
        it('exports isBlockedBrowserSubresource from browserCookies as well', () => {
            expect(exportedIsBlocked).toBe(isBlockedBrowserSubresource);
        });
    });

    describe('Navigation Request Protection', () => {
        it('never blocks top-level navigation requests, even if targeting an image/tracker URL', () => {
            const navRequest = {
                url: () => 'https://www.google-analytics.com/analytics.js',
                isNavigationRequest: () => true,
                resourceType: () => 'document'
            };
            expect(isBlockedBrowserSubresource(navRequest)).toBe(false);

            const imageNavRequest = {
                url: () => 'https://example.com/avatar.png',
                isNavigationRequest: () => true,
                resourceType: () => 'image'
            };
            expect(isBlockedBrowserSubresource(imageNavRequest)).toBe(false);
        });
    });

    describe('Playwright resourceType Filtering', () => {
        it('blocks standard heavy subresource types', () => {
            for (const type of ['image', 'media', 'font', 'texttrack', 'imageset']) {
                const req = {
                    url: () => 'https://example.com/asset',
                    isNavigationRequest: () => false,
                    resourceType: () => type
                };
                expect(isBlockedBrowserSubresource(req)).toBe(true);
            }
        });

        it('permits essential DOM and style resources', () => {
            for (const type of ['document', 'stylesheet', 'script', 'xhr', 'fetch']) {
                const req = {
                    url: () => 'https://example.com/app',
                    isNavigationRequest: () => false,
                    resourceType: () => type
                };
                expect(isBlockedBrowserSubresource(req)).toBe(false);
            }
        });
    });

    describe('File Extension Fallback Filtering', () => {
        it('blocks media and font URLs by extension when resourceType is missing or other', () => {
            const blockedUrls = [
                'https://cdn.example.com/images/hero.PNG',
                'https://cdn.example.com/photo.jpeg?size=large#preview',
                'https://cdn.example.com/graphic.webp',
                'https://cdn.example.com/icon.svg',
                'https://cdn.example.com/favicon.ico',
                'https://fonts.example.com/inter.woff2',
                'https://fonts.example.com/roboto.ttf',
                'https://cdn.example.com/video/teaser.mp4',
                'https://cdn.example.com/audio/sample.mp3'
            ];

            for (const url of blockedUrls) {
                const req = {
                    url: () => url,
                    isNavigationRequest: () => false,
                    resourceType: () => 'other'
                };
                expect(isBlockedBrowserSubresource(req)).toBe(true);
            }
        });

        it('does not block essential text/data extensions', () => {
            const allowedUrls = [
                'https://example.com/index.html',
                'https://cdn.example.com/styles/main.css',
                'https://cdn.example.com/bundle.js',
                'https://api.example.com/data.json',
                'https://example.com/feed.xml'
            ];

            for (const url of allowedUrls) {
                const req = {
                    url: () => url,
                    isNavigationRequest: () => false,
                    resourceType: () => 'other'
                };
                expect(isBlockedBrowserSubresource(req)).toBe(false);
            }
        });
    });

    describe('Tracker & Analytics Domain Filtering', () => {
        it('identifies known third-party tracker hostnames', () => {
            expect(isTrackerHost('google-analytics.com')).toBe(true);
            expect(isTrackerHost('www.google-analytics.com')).toBe(true);
            expect(isTrackerHost('analytics.google.com')).toBe(true);
            expect(isTrackerHost('googletagmanager.com')).toBe(true);
            expect(isTrackerHost('www.googletagmanager.com')).toBe(true);
            expect(isTrackerHost('hm.baidu.com')).toBe(true);
            expect(isTrackerHost('tongji.baidu.com')).toBe(true);
            expect(isTrackerHost('cnzz.com')).toBe(true);
            expect(isTrackerHost('s11.cnzz.com')).toBe(true);
            expect(isTrackerHost('clarity.ms')).toBe(true);
            expect(isTrackerHost('c.clarity.ms')).toBe(true);
            expect(isTrackerHost('browser.sentry-cdn.com')).toBe(true);
            expect(isTrackerHost('sentry.io')).toBe(true);
            expect(isTrackerHost('connect.facebook.net')).toBe(true);
        });

        it('does not misclassify primary content and search engine domains', () => {
            expect(isTrackerHost('google.com')).toBe(false);
            expect(isTrackerHost('www.google.com')).toBe(false);
            expect(isTrackerHost('baidu.com')).toBe(false);
            expect(isTrackerHost('www.baidu.com')).toBe(false);
            expect(isTrackerHost('bing.com')).toBe(false);
            expect(isTrackerHost('github.com')).toBe(false);
            expect(isTrackerHost('microsoft.com')).toBe(false);
        });

        it('blocks script requests when originating from tracker domains', () => {
            const trackerScriptReq = {
                url: () => 'https://www.googletagmanager.com/gtag/js?id=G-123456',
                isNavigationRequest: () => false,
                resourceType: () => 'script'
            };
            expect(isBlockedBrowserSubresource(trackerScriptReq)).toBe(true);

            const baiduTongjiReq = {
                url: () => 'https://hm.baidu.com/hm.js?123456',
                isNavigationRequest: () => false,
                resourceType: () => 'script'
            };
            expect(isBlockedBrowserSubresource(baiduTongjiReq)).toBe(true);
        });
    });

    describe('installBrowserResourceBlocker', () => {
        it('installs route handler and aborts blocked subresources while continuing allowed ones', async () => {
            let capturedPattern: string | undefined;
            let capturedHandler: ((route: any) => Promise<void>) | undefined;

            const fakePage: any = {
                route: vi.fn(async (pattern: string, handler: (route: any) => Promise<void>) => {
                    capturedPattern = pattern;
                    capturedHandler = handler;
                })
            };

            await installBrowserResourceBlocker(fakePage);

            expect(fakePage.route).toHaveBeenCalledTimes(1);
            expect(capturedPattern).toBe('**/*');
            expect(fakePage[RESOURCE_BLOCKER_INSTALLED]).toBe(true);

            // Test 1: Image request is aborted
            let imageAbortedWith: string | undefined;
            let imageContinued = false;
            const imageRoute = {
                request: () => ({
                    url: () => 'https://example.com/banner.jpg',
                    isNavigationRequest: () => false,
                    resourceType: () => 'image'
                }),
                abort: async (code?: string) => { imageAbortedWith = code; },
                continue: async () => { imageContinued = true; }
            };
            await capturedHandler!(imageRoute);
            expect(imageAbortedWith).toBe('blockedbyclient');
            expect(imageContinued).toBe(false);

            // Test 2: HTML/XHR request is continued
            let xhrAbortedWith: string | undefined;
            let xhrContinued = false;
            const xhrRoute = {
                request: () => ({
                    url: () => 'https://example.com/api/articles',
                    isNavigationRequest: () => false,
                    resourceType: () => 'xhr'
                }),
                abort: async (code?: string) => { xhrAbortedWith = code; },
                continue: async () => { xhrContinued = true; }
            };
            await capturedHandler!(xhrRoute);
            expect(xhrAbortedWith).toBeUndefined();
            expect(xhrContinued).toBe(true);

            // Test 3: Re-installing skips duplicate route registration
            await installBrowserResourceBlocker(fakePage);
            expect(fakePage.route).toHaveBeenCalledTimes(1);
        });

        it('gracefully handles pages without route support or throwing route handlers', async () => {
            await expect(installBrowserResourceBlocker(null)).resolves.toBeUndefined();
            await expect(installBrowserResourceBlocker({})).resolves.toBeUndefined();

            const throwingPage = {
                route: async () => {
                    throw new Error('CDP routing unsupported');
                }
            };
            await expect(installBrowserResourceBlocker(throwingPage)).resolves.toBeUndefined();
        });
    });
});
