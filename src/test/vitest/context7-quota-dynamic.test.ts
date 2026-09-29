import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    isContext7QuotaExhausted,
    markContext7QuotaExhausted,
    resetContext7QuotaExhaustedForTests,
    setContext7QuotaListener
} from '../../engines/context7/context7.js';

describe('Context7 quota state tracking and dynamic notification', () => {
    beforeEach(() => {
        resetContext7QuotaExhaustedForTests();
        delete process.env.CONTEXT7_API_KEY;
    });

    afterEach(() => {
        resetContext7QuotaExhaustedForTests();
        delete process.env.CONTEXT7_API_KEY;
    });

    it('should be false initially when no quota error has occurred', () => {
        expect(isContext7QuotaExhausted()).toBe(false);
    });

    it('should track quota exhaustion when markContext7QuotaExhausted is called', () => {
        markContext7QuotaExhausted();
        expect(isContext7QuotaExhausted()).toBe(true);
    });

    it('should notify registered listener when quota becomes exhausted', () => {
        const listener = vi.fn();
        setContext7QuotaListener(listener);

        markContext7QuotaExhausted();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should NOT treat quota as exhausted when a user CONTEXT7_API_KEY is configured', () => {
        markContext7QuotaExhausted();
        expect(isContext7QuotaExhausted()).toBe(true);

        process.env.CONTEXT7_API_KEY = 'test-valid-key';
        expect(isContext7QuotaExhausted()).toBe(false);
    });
});
