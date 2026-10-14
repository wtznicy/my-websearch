import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
    isBingImpersonateCircuitOpen,
    recordBingImpersonateFailure,
    recordBingImpersonateSuccess,
    resetBingImpersonateStateForTests
} from '../../engines/bing/impersonate.js';
import {
    createSearchService,
    extractSiteDomains,
    matchesSiteDomains
} from '../../core/search/searchService.js';
import {
    withEngineConcurrencySlot,
    configureEngineConcurrencyLimitsForTests
} from '../../core/search/engineExecutor.js';
import { startLocalDaemon } from '../../adapters/http/localDaemon.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';
import type { SearchResult } from '../../types.js';

describe('P0-1: Bing impersonate (wreq) circuit breaker', () => {
    const origBingImp = process.env.BING_IMPERSONATE;

    afterEach(() => {
        if (origBingImp === undefined) delete process.env.BING_IMPERSONATE;
        else process.env.BING_IMPERSONATE = origBingImp;
        resetBingImpersonateStateForTests();
    });

    it('opens circuit after 2 consecutive 0-result / failed wreq calls and resets on success', () => {
        expect(isBingImpersonateCircuitOpen()).toBe(false);
        recordBingImpersonateFailure();
        expect(isBingImpersonateCircuitOpen()).toBe(false);
        recordBingImpersonateFailure();
        expect(isBingImpersonateCircuitOpen()).toBe(true);

        recordBingImpersonateSuccess();
        expect(isBingImpersonateCircuitOpen()).toBe(false);
    });

    it('honors BING_IMPERSONATE=false environment switch', () => {
        process.env.BING_IMPERSONATE = 'false';
        expect(isBingImpersonateCircuitOpen()).toBe(true);
    });
});

describe('P1-4 & P1-9: SearchService singleflight deduplication and site: domain filtering', () => {
    it('extracts site: domains and filters off-domain results while allowing subdomains', () => {
        const domains = extractSiteDomains('tokio select site:docs.rs site:https://github.com/tokio-rs');
        expect(domains).toEqual(['docs.rs', 'github.com']);
        expect(matchesSiteDomains('https://docs.rs/tokio/latest/tokio/', domains)).toBe(true);
        expect(matchesSiteDomains('https://sub.docs.rs/page', domains)).toBe(true);
        expect(matchesSiteDomains('https://crates.io/crates/tokio', domains)).toBe(false);
    });

    it('deduplicates concurrent identical in-flight searches (P1-4) and filters site: domains (P1-9)', async () => {
        let engineCallCount = 0;
        const service = createSearchService({
            bing: async (): Promise<SearchResult[]> => {
                engineCallCount += 1;
                await new Promise((resolve) => setTimeout(resolve, 40));
                return [
                    {
                        title: 'Tokio Select on Docs.rs',
                        url: 'https://docs.rs/tokio/latest/tokio/macro.select.html',
                        description: 'tokio select macro documentation',
                        source: 'docs.rs',
                        engine: 'bing'
                    },
                    {
                        title: 'Off-site noise result',
                        url: 'https://unrelated.example.com/tokio-select',
                        description: 'tokio select noise',
                        source: 'unrelated.example.com',
                        engine: 'bing'
                    }
                ];
            }
        });

        const [res1, res2] = await Promise.all([
            service.execute({ query: 'tokio select site:docs.rs', limit: 5, engines: ['bing'], minResults: 0 }),
            service.execute({ query: 'tokio select site:docs.rs', limit: 5, engines: ['bing'], minResults: 0 })
        ]);

        // P1-4: 并发同参查询仅触发一次底层引擎调用
        expect(engineCallCount).toBe(1);
        // P1-9: 非 docs.rs 域名的噪声被后置过滤
        expect(res1.results.map((r) => r.url)).toEqual(['https://docs.rs/tokio/latest/tokio/macro.select.html']);
        expect(res2.results.map((r) => r.url)).toEqual(['https://docs.rs/tokio/latest/tokio/macro.select.html']);
    });
});

describe('P1-5: Per-engine concurrency limiter', () => {
    afterEach(() => {
        configureEngineConcurrencyLimitsForTests();
    });

    it('caps concurrent in-flight executions for the same engine', async () => {
        configureEngineConcurrencyLimitsForTests({ sogou: 2 });
        let active = 0;
        let maxActive = 0;

        const deadlineAt = Date.now() + 5000;
        const tasks = Array.from({ length: 5 }, () =>
            withEngineConcurrencySlot('sogou', deadlineAt, undefined, async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 25));
                active -= 1;
                return maxActive;
            })
        );

        await Promise.all(tasks);
        expect(maxActive).toBe(2);
    });
});

describe('P0-6: LocalDaemon Host header DNS-rebinding protection', () => {
    it('rejects requests with an untrusted Host header while allowing /health and 127.0.0.1', async () => {
        const runtime = createMyWebSearchRuntime();
        const daemon = await startLocalDaemon(runtime, { host: '127.0.0.1', port: 0, version: 'test' });
        try {
            const parsedUrl = new URL(daemon.baseUrl);
            const port = Number(parsedUrl.port);

            const requestWithHost = (path: string, hostHeader: string): Promise<{ statusCode: number; body: string }> =>
                new Promise((resolve, reject) => {
                    const req = http.request(
                        {
                            hostname: '127.0.0.1',
                            port,
                            path,
                            method: 'GET',
                            headers: { Host: hostHeader }
                        },
                        (res) => {
                            let data = '';
                            res.on('data', (chunk) => { data += chunk; });
                            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
                        }
                    );
                    req.on('error', reject);
                    req.end();
                });

            const evilStatus = await requestWithHost('/status', 'evil-rebind.attacker.com');
            expect(evilStatus.statusCode).toBe(403);

            const healthResp = await requestWithHost('/health', 'evil-rebind.attacker.com');
            expect(healthResp.statusCode).toBe(200);

            const localStatus = await requestWithHost('/status', `127.0.0.1:${port}`);
            expect(localStatus.statusCode).toBe(200);
        } finally {
            await daemon.close();
        }
    });
});
