import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    isEngineCircuitOpen,
    tripEngineCircuit,
    getEngineCircuitRemainingMs,
    resetEngineCircuits
} from '../../core/search/engineCircuitBreaker.js';

afterEach(() => {
    resetEngineCircuits();
    vi.useRealTimers();
});

describe('engineCircuitBreaker', () => {
    it('should be closed by default', () => {
        expect(isEngineCircuitOpen('brave')).toBe(false);
        expect(getEngineCircuitRemainingMs('brave')).toBe(0);
    });

    it('should open on trip and report remaining cooldown', () => {
        tripEngineCircuit('brave', 5000);
        expect(isEngineCircuitOpen('brave')).toBe(true);
        expect(getEngineCircuitRemainingMs('brave')).toBeGreaterThan(4000);
        // 其他引擎不受影响
        expect(isEngineCircuitOpen('bing')).toBe(false);
    });

    it('should auto-close after the cooldown elapses', () => {
        vi.useFakeTimers();
        tripEngineCircuit('brave', 1000);
        expect(isEngineCircuitOpen('brave')).toBe(true);
        vi.advanceTimersByTime(1001);
        expect(isEngineCircuitOpen('brave')).toBe(false);
        expect(getEngineCircuitRemainingMs('brave')).toBe(0);
    });

    it('should extend the cooldown when tripped again', () => {
        vi.useFakeTimers();
        tripEngineCircuit('brave', 5000);
        vi.advanceTimersByTime(3000);
        const beforeExtend = getEngineCircuitRemainingMs('brave');
        tripEngineCircuit('brave', 5000);
        expect(getEngineCircuitRemainingMs('brave')).toBeGreaterThan(beforeExtend);
    });

    it('should clear all circuits on reset', () => {
        tripEngineCircuit('brave');
        tripEngineCircuit('duckduckgo');
        resetEngineCircuits();
        expect(isEngineCircuitOpen('brave')).toBe(false);
        expect(isEngineCircuitOpen('duckduckgo')).toBe(false);
    });
});
