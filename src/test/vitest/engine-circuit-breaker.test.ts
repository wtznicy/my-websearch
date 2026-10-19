import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    isEngineCircuitOpen,
    tripEngineCircuit,
    getEngineCircuitRemainingMs,
    getEngineCircuitTripCount,
    recordEngineSuccess,
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

    it('uses a 30s base cooldown and exponential backoff capped at 5 minutes', () => {
        vi.useFakeTimers();
        expect(tripEngineCircuit('duckduckgo')).toBe(30_000);
        expect(tripEngineCircuit('duckduckgo')).toBe(60_000);
        expect(tripEngineCircuit('duckduckgo')).toBe(120_000);
        expect(tripEngineCircuit('duckduckgo')).toBe(240_000);
        expect(tripEngineCircuit('duckduckgo')).toBe(300_000);
    });

    it('resets consecutive trips and opens no longer after a successful call', () => {
        tripEngineCircuit('duckduckgo');
        expect(getEngineCircuitTripCount('duckduckgo')).toBe(1);
        expect(isEngineCircuitOpen('duckduckgo')).toBe(true);

        recordEngineSuccess('duckduckgo');
        expect(getEngineCircuitTripCount('duckduckgo')).toBe(0);
        expect(isEngineCircuitOpen('duckduckgo')).toBe(false);
        expect(tripEngineCircuit('duckduckgo')).toBe(30_000);
    });

    it('honours ENGINE_CIRCUIT_BASE_COOLDOWN_MS / ENGINE_CIRCUIT_MAX_COOLDOWN_MS', () => {
        vi.useFakeTimers();
        const prevBase = process.env.ENGINE_CIRCUIT_BASE_COOLDOWN_MS;
        const prevMax = process.env.ENGINE_CIRCUIT_MAX_COOLDOWN_MS;
        process.env.ENGINE_CIRCUIT_BASE_COOLDOWN_MS = '5000';
        process.env.ENGINE_CIRCUIT_MAX_COOLDOWN_MS = '10000';
        try {
            expect(tripEngineCircuit('bing')).toBe(5000);
            expect(tripEngineCircuit('bing')).toBe(10_000);
            expect(tripEngineCircuit('bing')).toBe(10_000);
        } finally {
            if (prevBase === undefined) delete process.env.ENGINE_CIRCUIT_BASE_COOLDOWN_MS;
            else process.env.ENGINE_CIRCUIT_BASE_COOLDOWN_MS = prevBase;
            if (prevMax === undefined) delete process.env.ENGINE_CIRCUIT_MAX_COOLDOWN_MS;
            else process.env.ENGINE_CIRCUIT_MAX_COOLDOWN_MS = prevMax;
        }
    });

    it('should clear all circuits on reset', () => {
        tripEngineCircuit('brave');
        tripEngineCircuit('duckduckgo');
        resetEngineCircuits();
        expect(isEngineCircuitOpen('brave')).toBe(false);
        expect(isEngineCircuitOpen('duckduckgo')).toBe(false);
    });

    it('should trip circuit breaker when engine returns HTTP 202 or bot_challenge', async () => {
        const { executePrimaryEngines } = await import('../../core/search/engineExecutor.js');
        const { AppError } = await import('../../core/errors.js');

        expect(isEngineCircuitOpen('duckduckgo')).toBe(false);

        await executePrimaryEngines({
            query: 'test ddg 202',
            searchQuery: 'test ddg 202',
            executableEngines: ['duckduckgo'],
            limits: [5],
            engineMap: {
                duckduckgo: async () => {
                    throw new AppError({
                        code: 'bot_challenge',
                        status: 202,
                        retryable: false,
                        engine: 'duckduckgo',
                        message: 'DuckDuckGo returned a challenge page (HTTP 202)'
                    });
                }
            },
            deadlineAt: Date.now() + 5000,
            perEngineTimeoutMs: 5000
        });

        expect(isEngineCircuitOpen('duckduckgo')).toBe(true);
        expect(getEngineCircuitRemainingMs('duckduckgo')).toBeGreaterThan(0);
    });
});
