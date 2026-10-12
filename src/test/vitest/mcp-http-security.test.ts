import { describe, it, expect } from 'vitest';
import { createConfig } from '../../config.js';
import {
    resolveCorsOrigin,
    buildMcpCorsOptions,
    createSessionCapacityManager
} from '../../adapters/http/mcpHttpSecurity.js';

describe('MCP HTTP security: CORS & session capacity', () => {
    describe('CORS configuration', () => {
        it('disables CORS by default when ENABLE_CORS is not set', () => {
            const cfg = createConfig({}, { quiet: true });
            expect(cfg.enableCors).toBe(false);
            expect(buildMcpCorsOptions(cfg)).toBeNull();
        });

        it('enables CORS with wildcard when ENABLE_CORS=true and CORS_ORIGIN is unset', () => {
            const cfg = createConfig({ ENABLE_CORS: 'true' }, { quiet: true });
            expect(cfg.enableCors).toBe(true);
            const options = buildMcpCorsOptions(cfg);
            expect(options).not.toBeNull();
            expect(options?.origin).toBe('*');
        });

        it('supports single and comma-separated origin whitelists', () => {
            expect(resolveCorsOrigin('http://localhost:3000')).toBe('http://localhost:3000');
            expect(resolveCorsOrigin('http://localhost:3000, https://app.example.com')).toEqual([
                'http://localhost:3000',
                'https://app.example.com'
            ]);
            expect(resolveCorsOrigin('http://localhost:3000, *')).toBe('*');

            const cfg = createConfig(
                {
                    ENABLE_CORS: 'true',
                    CORS_ORIGIN: 'http://localhost:3000,http://127.0.0.1:5173'
                },
                { quiet: true }
            );
            const options = buildMcpCorsOptions(cfg);
            expect(options?.origin).toEqual(['http://localhost:3000', 'http://127.0.0.1:5173']);
        });
    });

    describe('createSessionCapacityManager (unified /mcp + /sse counter)', () => {
        it('counts in-flight initializing sessions alongside active streamable and SSE sessions', () => {
            let activeStreamable = 0;
            let activeSse = 0;
            const capacity = createSessionCapacityManager(2, () => activeStreamable + activeSse);

            // 1. Pre-occupy slot 1 via /mcp initialization (before onsessioninitialized fires)
            const r1 = capacity.tryReserve();
            expect(r1).not.toBeNull();
            expect(capacity.getInitializingCount()).toBe(1);
            expect(capacity.getOccupiedCount()).toBe(1);

            // 2. Pre-occupy slot 2 via /sse initialization concurrently
            const r2 = capacity.tryReserve();
            expect(r2).not.toBeNull();
            expect(capacity.getInitializingCount()).toBe(2);
            expect(capacity.getOccupiedCount()).toBe(2);

            // 3. Third concurrent attempt (either /mcp or /sse) is rejected immediately even though active count is still 0
            expect(capacity.tryReserve()).toBeNull();

            // 4. Promote r1 to active streamable session: occupied remains 2 (no double counting)
            activeStreamable += 1;
            r1!.promoteToActive();
            expect(capacity.getInitializingCount()).toBe(1);
            expect(capacity.getActiveCount()).toBe(1);
            expect(capacity.getOccupiedCount()).toBe(2);
            expect(capacity.tryReserve()).toBeNull();

            // 5. Simulate r2 failing during initialization: release frees the slot
            r2!.release();
            expect(capacity.getInitializingCount()).toBe(0);
            expect(capacity.getOccupiedCount()).toBe(1);

            // 6. Now a new /sse session can reserve the freed slot and promote to active
            const r3 = capacity.tryReserve();
            expect(r3).not.toBeNull();
            activeSse += 1;
            r3!.promoteToActive();
            expect(capacity.getOccupiedCount()).toBe(2);

            // 7. Closing active streamable session frees slot
            activeStreamable -= 1;
            r1!.release(); // idempotent after promoteToActive
            expect(capacity.getOccupiedCount()).toBe(1);
        });
    });
});
