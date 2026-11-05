import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    setEngineBrowserOnly,
    isEngineBrowserOnly,
    getEngineBrowserOnlyRemainingMs,
    clearEngineBrowserOnly,
    resetEngineBrowserOnly
} from '../../core/search/engineBrowserOnly.js';
import { shouldPreferBraveBrowser } from '../../engines/brave/brave.js';
import { shouldPreferBingBrowser, isBing301OrBlocked } from '../../engines/bing/bing.js';
import { config } from '../../config.js';
import { sortCandidatesByRecentHealth } from '../../core/search/cascadeExecutor.js';

afterEach(() => {
    resetEngineBrowserOnly();
    vi.useRealTimers();
    delete process.env.BRAVE_BROWSER_FALLBACK;
});

describe('engineBrowserOnly', () => {
    it('is off by default', () => {
        expect(isEngineBrowserOnly('brave')).toBe(false);
        expect(isEngineBrowserOnly('bing')).toBe(false);
        expect(getEngineBrowserOnlyRemainingMs('brave')).toBe(0);
        expect(getEngineBrowserOnlyRemainingMs('bing')).toBe(0);
    });

    it('opens a window and expires it', () => {
        vi.useFakeTimers();
        setEngineBrowserOnly('brave', 180_000);
        expect(isEngineBrowserOnly('brave')).toBe(true);
        expect(getEngineBrowserOnlyRemainingMs('brave')).toBeGreaterThan(170_000);
        vi.advanceTimersByTime(180_001);
        expect(isEngineBrowserOnly('brave')).toBe(false);
        expect(getEngineBrowserOnlyRemainingMs('brave')).toBe(0);
    });

    it('ignores non-positive durations and can be cleared', () => {
        setEngineBrowserOnly('brave', 0);
        expect(isEngineBrowserOnly('brave')).toBe(false);

        setEngineBrowserOnly('brave', 60_000);
        expect(isEngineBrowserOnly('brave')).toBe(true);
        clearEngineBrowserOnly('brave');
        expect(isEngineBrowserOnly('brave')).toBe(false);
    });

    it('shouldPreferBraveBrowser honors the window and the disable switch', () => {
        expect(shouldPreferBraveBrowser()).toBe(false);

        setEngineBrowserOnly('brave', 60_000);
        expect(shouldPreferBraveBrowser()).toBe(true);

        process.env.BRAVE_BROWSER_FALLBACK = '0';
        expect(shouldPreferBraveBrowser()).toBe(false);
    });

    it('shouldPreferBingBrowser honors the window and bingPlaywrightFallback config', () => {
        const original = config.bingPlaywrightFallback;
        try {
            config.bingPlaywrightFallback = true;
            expect(shouldPreferBingBrowser()).toBe(false);

            setEngineBrowserOnly('bing', 60_000);
            expect(shouldPreferBingBrowser()).toBe(true);

            config.bingPlaywrightFallback = false;
            expect(shouldPreferBingBrowser()).toBe(false);
        } finally {
            config.bingPlaywrightFallback = original;
        }
    });

    it('isBing301OrBlocked identifies 301/redirect/anti-bot errors correctly', () => {
        expect(isBing301OrBlocked(new Error('Request failed with status code 301'))).toBe(true);
        expect(isBing301OrBlocked(new Error('Redirect loop or 302 found'))).toBe(true);
        expect(isBing301OrBlocked(new Error('verification required'))).toBe(true);
        expect(isBing301OrBlocked({ status: 301 })).toBe(true);
        expect(isBing301OrBlocked({ status: 302 })).toBe(true);
        expect(isBing301OrBlocked({ status: 429 })).toBe(true);

        // abort 不应触发反爬软窗口
        expect(isBing301OrBlocked(new Error('Search aborted'))).toBe(false);
        expect(isBing301OrBlocked({ code: 'aborted' })).toBe(false);
        // 普通 404/500 等
        expect(isBing301OrBlocked(new Error('Internal server error'))).toBe(false);
    });

    it('cascade ordering puts browser-only engines last', () => {
        setEngineBrowserOnly('brave', 60_000);
        const ordered = sortCandidatesByRecentHealth(['brave', 'engineA', 'engineB']);
        expect(ordered.indexOf('brave')).toBeGreaterThan(ordered.indexOf('engineA'));
        expect(ordered.indexOf('brave')).toBeGreaterThan(ordered.indexOf('engineB'));
    });
});
