import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import { probeTcpConnect, runInlineDiagnostics } from '../../utils/networkDiagnostics.js';

describe('Network Inline Diagnostics', () => {
    it('returns false for unreachable local ports within timeout', async () => {
        // Port 59999 is typically unused and will be refused or timed out immediately
        const reachable = await probeTcpConnect('127.0.0.1', 59999, 100);
        expect(reachable).toBe(false);
    });

    it('returns diagnostics structure with proxy, dns, suggestion', async () => {
        const diagnostics = await runInlineDiagnostics('https://invalid-non-existent-domain-xyz-12345.com');
        expect(diagnostics).toBeDefined();
        expect(diagnostics.dns).toBeDefined();
        expect(diagnostics.suggestion).toBeDefined();
    });
});
