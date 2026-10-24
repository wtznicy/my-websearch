import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetLogStateForTests, configureLogging, isLevelEnabled, log, resolveLogLevel } from '../../core/log.js';

describe('core logging', () => {
    afterEach(() => {
        __resetLogStateForTests();
        vi.restoreAllMocks();
    });

    it('resolves LOG_LEVEL aliases', () => {
        expect(resolveLogLevel('quiet', false)).toBe('warn');
        expect(resolveLogLevel('normal', true)).toBe('info');
        expect(resolveLogLevel(undefined, true)).toBe('warn');
        expect(resolveLogLevel(undefined, false)).toBe('info');
        expect(resolveLogLevel('silent', false)).toBe('silent');
    });

    it('filters by level and writes to stderr', () => {
        const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        configureLogging({ level: 'warn', prefix: 'test' });
        expect(isLevelEnabled('info')).toBe(false);
        expect(isLevelEnabled('warn')).toBe(true);
        log.info('hidden');
        log.warn('visible');
        expect(write).toHaveBeenCalledTimes(1);
        expect(String(write.mock.calls[0]?.[0])).toContain('[warn] [test] visible');
    });
});
