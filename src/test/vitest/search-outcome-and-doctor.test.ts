import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createConfig, formatSanitizedConfigSummary, sanitizeUrlForLog } from '../../config.js';
import { flattenConfigFileToEnv, getAppConfigFilePath, loadApplicationConfigEnv, shouldEmitConfigStartupLog } from '../../configLoader.js';
import { looksLikeBotChallengePage } from '../../core/antiBot/antiBotDetection.js';
import { executeCascade, pickCascadeCandidates } from '../../core/search/cascadeExecutor.js';
import { executePrimaryEngines } from '../../core/search/engineExecutor.js';
import {
    createSearchService,
    computeSearchOutcome,
    normalizeResultUrl,
    Semaphore
} from '../../core/search/searchService.js';
import { createBrowserBudget, fetchWebContent, __setBrowserCookieHeaderForTests, __setBrowserHtmlFetcherForTests } from '../../engines/web/fetchWebContent.js';
import {
    AppError,
    extractErrorCode,
    extractErrorDetails,
    getErrorClassificationMetrics,
    isAppError,
    isRetryableError,
    resetErrorClassificationMetrics
} from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';
import { runCli } from '../../cli/runCli.js';
import {
    maskSecret,
    maskProxyUrl,
    buildDoctorReport,
    clearDoctorProbeCache,
    probeBrowserLaunch,
    sanitizeBrowserTargetForDoctor,
    verifyEngineProbeResponseStructure
} from '../../cli/doctor.js';
import { searchContext7Libraries, fetchContext7Docs } from '../../engines/context7/context7.js';
import { extractResultsFromHtml as extractStartpageResults } from '../../engines/startpage/startpage.js';
import { impersonateHttpGet } from '../../utils/impersonateRequest.js';
import { paginateSearch } from '../../utils/pagination.js';

describe('Search Outcome Semantics (ok / degraded / empty / failed)', () => {
    it('classifies ok, degraded, empty, and failed outcomes accurately', async () => {
        // 1. ok: results > 0, no failures
        const okService = createSearchService({
            bing: async () => [{
                title: 'Valid Result Title',
                url: 'https://example.com/1',
                description: 'Substantive result description',
                source: 'example.com',
                engine: 'bing'
            }]
        });
        const okRes = await okService.execute({ query: 'test', engines: ['bing'], limit: 5 });
        expect(okRes.outcome).toBe('ok');
        expect(okRes.retryable).toBe(false);

        // 2. degraded: results > 0, partial failure from second engine
        const degradedService = createSearchService({
            bing: async () => [{
                title: 'Valid Result Title',
                url: 'https://example.com/1',
                description: 'Substantive result description',
                source: 'example.com',
                engine: 'bing'
            }],
            sogou: async () => {
                throw new Error('anti-bot captcha challenge page');
            }
        });
        const degradedRes = await degradedService.execute({ query: 'test', engines: ['bing', 'sogou'], limit: 5 });
        expect(degradedRes.outcome).toBe('degraded');
        expect(degradedRes.retryable).toBe(false);
        expect(degradedRes.totalResults).toBe(1);

        // 3. empty: engine completes normally with 0 results
        const emptyService = createSearchService({
            bing: async () => []
        });
        const emptyRes = await emptyService.execute({ query: 'nonexistentxyz123', engines: ['bing'], limit: 5 });
        expect(emptyRes.outcome).toBe('empty');
        expect(emptyRes.retryable).toBe(false);
        expect(emptyRes.partialFailures[0]?.code).toBe('no_results');

        // 4. failed (retryable): all engines fail with transient error
        const failedRetryable = computeSearchOutcome(0, [{
            engine: 'bing',
            code: 'engine_error',
            message: 'Engine timeout after 10000ms'
        }]);
        expect(failedRetryable).toEqual({ outcome: 'failed', retryable: true });

        // 5. failed (non-retryable): anti-bot challenge or missing API key
        const failedNonRetryable = computeSearchOutcome(0, [{
            engine: 'bing',
            code: 'engine_error',
            message: 'anti-bot verification page blocked'
        }]);
        expect(failedNonRetryable).toEqual({ outcome: 'failed', retryable: false });

        const failedMissingKey = computeSearchOutcome(0, [{
            engine: 'exa',
            code: 'engine_error',
            message: 'Exa engine requires EXA_API_KEY to be configured.'
        }]);
        expect(failedMissingKey).toEqual({ outcome: 'failed', retryable: false });
    });

    it('terminates in-flight HTTP requests and pagination when AbortSignal fires on timeout', async () => {
        let serverRequestClosed = false;
        let resolveSocketClosed!: () => void;
        const socketClosedPromise = new Promise<void>((resolve) => {
            resolveSocketClosed = resolve;
        });

        const server = http.createServer((req, res) => {
            req.on('close', () => {
                if (!res.writableEnded) {
                    serverRequestClosed = true;
                    resolveSocketClosed();
                }
            });
            // Never respond within test window
            setTimeout(() => {
                if (!res.writableEnded) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<html><body>late</body></html>');
                }
            }, 5000).unref();
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address() as { port: number };
        const url = `http://127.0.0.1:${address.port}/search`;

        try {
            const res = await executePrimaryEngines({
                query: 'abort test',
                searchQuery: 'abort test',
                executableEngines: ['bing'],
                limits: [5],
                engineMap: {
                    bing: async (_q, _l, ctx) => {
                        await impersonateHttpGet('bing', url, {
                            timeout: 5000,
                            signal: ctx?.signal
                        });
                        return [];
                    }
                },
                deadlineAt: Date.now() + 80,
                perEngineTimeoutMs: 80
            });

            expect(res.engineMetrics[0]?.timedOut).toBe(true);
            await Promise.race([
                socketClosedPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('in-flight HTTP request was not aborted')), 1000))
            ]);
            expect(serverRequestClosed).toBe(true);

            // Also verify paginateSearch stops immediately when signal aborts during page delay
            const controller = new AbortController();
            let fetchedPages = 0;
            setTimeout(() => controller.abort(new Error('pagination cancelled')), 30);
            await expect(
                paginateSearch({
                    limit: 10,
                    pageDelayMs: [2000, 2000],
                    signal: controller.signal,
                    fetchPage: async () => {
                        fetchedPages += 1;
                        return [{
                            title: `Item ${fetchedPages}`,
                            url: `https://example.com/${fetchedPages}`,
                            description: 'desc',
                            source: 'example.com',
                            engine: 'bing'
                        }];
                    }
                })
            ).rejects.toThrow(/pagination cancelled|aborted/i);
            expect(fetchedPages).toBe(1);
        } finally {
            server.close();
        }
    });

    it('does not record duplicate no_results when a cascade engine times out', async () => {
        const cascadeRes = await executeCascade({
            cleanQuery: 'cascade timeout test',
            searchQuery: 'cascade timeout test',
            minResults: 3,
            initialMerged: [],
            initialEngineResults: [],
            engines: ['bing'],
            engineMap: {
                sogou: async (_q, _l, ctx) => {
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(resolve, 500);
                        ctx?.signal?.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('aborted'));
                        }, { once: true });
                    });
                    return [];
                }
            },
            deadlineAt: Date.now() + 5000,
            perEngineTimeoutMs: 40
        });

        const sogouFailures = cascadeRes.cascadeFailures.filter((f) => f.engine === 'sogou');
        expect(sogouFailures).toHaveLength(1);
        expect(sogouFailures[0]?.code).toBe('engine_error');
        expect(sogouFailures[0]?.retryable).toBe(true);
    });
});

describe('Lazy Browser Budget, Anti-Bot Precision, URL Deduplication & Semaphore Queue', () => {
    it('starts browser stage budget lazily on first entry and rejects before invoking task when exhausted', async () => {
        const withinBudget = createBrowserBudget('cookie', 80);
        // Wait 120ms before first use — should NOT consume the 80ms stage budget
        await new Promise((resolve) => setTimeout(resolve, 120));

        // First fast call (15ms) succeeds because the 80ms timer only starts now
        const fastVal = await withinBudget(async (signal) => {
            expect(signal.aborted).toBe(false);
            await new Promise((resolve) => setTimeout(resolve, 15));
            return 'ok';
        }, 'cookie fast check');
        expect(fastVal).toBe('ok');

        // Second call exceeds remaining ~65ms budget and aborts signal
        let stageSignalAborted = false;
        const slowErr = await withinBudget(async (signal) => {
            signal.addEventListener('abort', () => {
                stageSignalAborted = true;
            }, { once: true });
            await new Promise((resolve) => setTimeout(resolve, 100));
            return 'unused';
        }, 'cookie warmup').catch((err: Error) => err);

        expect(slowErr).toBeInstanceOf(Error);
        expect((slowErr as Error).message).toContain('cookie browser fallback budget (80ms) exceeded during cookie warmup');
        expect(stageSignalAborted).toBe(true);

        // Once exhausted, subsequent withinBudget call must NOT invoke task factory
        let thirdTaskInvoked = false;
        await expect(
            withinBudget(async () => {
                thirdTaskInvoked = true;
                return 'should not run';
            }, 'third attempt')
        ).rejects.toThrow(/exhausted before third attempt/);
        expect(thirdTaskInvoked).toBe(false);
    });

    it('does not misclassify short technical articles mentioning verification, captcha, or rate limit as bot challenges', () => {
        expect(
            looksLikeBotChallengePage(
                'In this guide we implement email verification and rate limit middleware in Express with Redis.'
            )
        ).toBe(false);
        expect(
            looksLikeBotChallengePage(
                'How to test captcha accessibility and handle blocked webhook retries in unit tests.'
            )
        ).toBe(false);

        // Genuine short bot challenge pages must still be detected
        expect(looksLikeBotChallengePage('Just a moment... Checking your browser before accessing example.com.')).toBe(true);
        expect(looksLikeBotChallengePage('你似乎来到了没有知识存在的荒原 - 知乎')).toBe(true);
        expect(looksLikeBotChallengePage('环境异常，完成验证后即可继续访问')).toBe(true);
    });

    it('preserves meaningful ref query params while stripping utm_* and platform-specific spm', () => {
        const gitMain = normalizeResultUrl('https://docs.example.com/file?ref=main&utm_source= newsletter ');
        const gitV2 = normalizeResultUrl('https://docs.example.com/file?ref=v2.0&utm_medium=social');
        expect(gitMain).toBe('https://docs.example.com/file?ref=main');
        expect(gitV2).toBe('https://docs.example.com/file?ref=v2.0');
        expect(gitMain).not.toBe(gitV2);

        // spm stripped on known content platforms (e.g. csdn.net / aliyun.com) but kept on arbitrary hosts
        expect(normalizeResultUrl('https://blog.csdn.net/user/article/details/123?spm=1001.2101.3001.6650.1')).toBe(
            'https://blog.csdn.net/user/article/details/123'
        );
        expect(normalizeResultUrl('https://custom.example.org/view?spm=keepme')).toBe(
            'https://custom.example.org/view?spm=keepme'
        );
    });

    it('enforces Semaphore queue capacity limit and queue wait deadline', async () => {
        const sem = new Semaphore(1, 1);
        await sem.acquire();

        // Queue 1 item with a short deadline (40ms) and attach rejection handler immediately
        const queuedOutcome = sem.acquire(Date.now() + 40).then(
            () => null,
            (err: Error) => err
        );

        // Second queued item exceeds maxQueueSize=1
        await expect(sem.acquire(Date.now() + 1000)).rejects.toThrow(/concurrency queue is full/i);

        // Wait for first queued item's deadline to expire before release
        const timeoutErr = await queuedOutcome;
        expect(timeoutErr).toBeInstanceOf(Error);
        expect(timeoutErr?.message).toMatch(/Search timed out after waiting .* in concurrency queue/i);

        sem.release();
    });
});

describe('CLI search failed outcome, configLoader priority & doctor command', () => {
    function createTestRuntime(
        bingExecutor: () => Promise<Array<{ title: string; url: string; description: string; source: string; engine: string }>>,
        envOverrides: Record<string, string> = {}
    ) {
        return createMyWebSearchRuntime({
            config: createConfig({
                PROXY_URL: 'http://myuser:supersecret@127.0.0.1:65531;duckduckgo',
                DEFAULT_SEARCH_ENGINE: 'bing',
                ...envOverrides
            }),
            dependencies: {
                searchExecutors: {
                    bing: bingExecutor
                },
                fetchGithubReadme: async () => '# README',
                fetchWebContent: async (url) => ({
                    url,
                    finalUrl: url,
                    contentType: 'text/plain',
                    title: 'Example',
                    retrievalMethod: 'request' as const,
                    truncated: false,
                    content: 'ok',
                    totalLength: 2,
                    startIndex: 0
                }),
                fetchCsdnArticle: async () => ({ content: 'csdn' }),
                fetchJuejinArticle: async () => ({ content: 'juejin' })
            }
        });
    }

    it('returns error envelope with retryable=false for anti-bot failure and retryable=true for transient failure in CLI', async () => {
        const prevPort = process.env.OPEN_WEBSEARCH_DAEMON_PORT;
        process.env.OPEN_WEBSEARCH_DAEMON_PORT = '65530';
        try {
            // 1. Non-retryable anti-bot failure
            const nonRetryableRuntime = createTestRuntime(async () => {
                throw new Error('anti-bot challenge page');
            });
            const stdout1: string[] = [];
            const exitCode1 = await runCli(
                ['search', 'failing query', '--engine', 'bing', '--json'],
                nonRetryableRuntime,
                {
                    stdout: (t) => stdout1.push(t),
                    stderr: () => undefined
                }
            );

            expect(exitCode1).toBe(1);
            const payload1 = JSON.parse(stdout1[0]!) as {
                status: string;
                data: { outcome: string; retryable: boolean; totalResults: number; partialFailures: unknown[] };
                error: { code: string; retryable: boolean };
            };
            expect(payload1.status).toBe('error');
            expect(payload1.data.outcome).toBe('failed');
            expect(payload1.error.retryable).toBe(false);

            // 2. Retryable transient timeout failure
            const retryableRuntime = createTestRuntime(async () => {
                throw new Error('Engine timeout after 10000ms');
            });
            const stdout2: string[] = [];
            const exitCode2 = await runCli(
                ['search', 'timeout query', '--engine', 'bing', '--json'],
                retryableRuntime,
                {
                    stdout: (t) => stdout2.push(t),
                    stderr: () => undefined
                }
            );
            expect(exitCode2).toBe(1);
            const payload2 = JSON.parse(stdout2[0]!) as {
                status: string;
                data: { outcome: string; retryable: boolean };
                error: { code: string; retryable: boolean };
            };
            expect(payload2.data.retryable).toBe(true);
            expect(payload2.error.retryable).toBe(true);
        } finally {
            if (prevPort === undefined) {
                delete process.env.OPEN_WEBSEARCH_DAEMON_PORT;
            } else {
                process.env.OPEN_WEBSEARCH_DAEMON_PORT = prevPort;
            }
        }
    });

    it('preserves explicit empty values in .env over lower-priority config files and tracks keySources accurately', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mywebsearch-cfg-test-'));
        try {
            // High-priority .env explicitly clears PROXY_URL=""
            fs.writeFileSync(path.join(tmpDir, '.env'), 'PROXY_URL=""\nDEFAULT_SEARCH_ENGINE=sogou\n', 'utf8');
            // Lower-priority .my-websearch.json defines proxy.url and EXA_API_KEY
            fs.writeFileSync(
                path.join(tmpDir, '.my-websearch.json'),
                JSON.stringify({
                    proxy: {
                        url: 'http://127.0.0.1:10808',
                        useProxy: true,
                        engines: ['bing']
                    },
                    apiKeys: {
                        exa: 'exa-from-project-json'
                    }
                }),
                'utf8'
            );
            // Lowest-priority app config defines CONTEXT7_API_KEY
            const appDataDir = path.join(tmpDir, 'appdata');
            fs.mkdirSync(appDataDir, { recursive: true });
            fs.writeFileSync(
                path.join(appDataDir, 'config.json'),
                JSON.stringify({
                    proxy: {
                        url: 'http://127.0.0.1:7897',
                        useProxy: true
                    },
                    apiKeys: {
                        context7: 'ctx7-from-app-json',
                        exa: 'exa-from-app-json'
                    }
                }),
                'utf8'
            );

            const targetEnv: NodeJS.ProcessEnv = {
                MYWEBSEARCH_DATA_DIR: appDataDir,
                SEARCH_MODE: 'request'
            };

            loadApplicationConfigEnv(targetEnv, { cwd: tmpDir, quiet: true });

            // .env's empty PROXY_URL="" must NOT be overwritten by .my-websearch.json or config.json
            expect(targetEnv.PROXY_URL).toBe('');
            expect(targetEnv.USE_PROXY).toBeUndefined();
            expect(targetEnv.EXA_API_KEY).toBe('exa-from-project-json');
            expect(targetEnv.CONTEXT7_API_KEY).toBe('ctx7-from-app-json');

            const runtime = createTestRuntime(async () => [], {
                PLAYWRIGHT_CDP_ENDPOINT: 'http://127.0.0.1:65529'
            });
            const report = await buildDoctorReport(runtime, {
                env: targetEnv,
                cwd: tmpDir,
                version: '1.0.23-test',
                proxyProbeTimeoutMs: 80
            });

            // Only SEARCH_MODE was in initial process.env; file-injected keys have their exact file sources
            expect(report.configSources.envOverrides).toEqual(['SEARCH_MODE']);
            expect(report.configSources.keySources.SEARCH_MODE).toBe('process_env');
            expect(report.configSources.keySources.DEFAULT_SEARCH_ENGINE).toBe('dot_env');
            expect(report.configSources.keySources.EXA_API_KEY).toBe('project_config_json');
            expect(report.configSources.keySources.CONTEXT7_API_KEY).toBe('app_config_json');
            expect(report.configSources.projectConfigFile.exists).toBe(true);

            // Unreachable CDP endpoint must report available=false and status='unreachable'
            expect(report.browser.mode).toBe('cdp');
            expect(report.browser.available).toBe(false);
            expect(report.browser.status).toBe('unreachable');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('masks secrets, reports missing_api_key for exa, and supports doctor --network in CLI', async () => {
        expect(maskSecret('ctx7sk-1234567890')).toBe('ctx***90');
        expect(maskSecret('short')).toBe('***');
        expect(maskSecret('')).toBeNull();
        expect(maskProxyUrl('http://alice:hunter2@127.0.0.1:7897;all')).toBe('http://***:***@127.0.0.1:7897;all');

        const runtime = createTestRuntime(async () => []);
        const reportWithoutExaKey = await buildDoctorReport(runtime, {
            env: {
                CONTEXT7_API_KEY: 'ctx7sk-secret-key-99',
                GITHUB_TOKEN: 'ghp_secret_token_77'
            },
            version: '1.0.23-test',
            proxyProbeTimeoutMs: 80
        });

        expect(reportWithoutExaKey.version).toBe('1.0.23-test');
        expect(reportWithoutExaKey.effectiveConfig.proxyUrl).toBe('http://***:***@127.0.0.1:65531');
        expect(reportWithoutExaKey.effectiveConfig.proxyEngines).toEqual(['duckduckgo']);
        expect(reportWithoutExaKey.effectiveConfig.proxyUrl).not.toContain('supersecret');
        expect(reportWithoutExaKey.effectiveConfig.apiKeys.context7).toBe('ctx***99');
        expect(reportWithoutExaKey.effectiveConfig.apiKeys.exa).toBeNull();
        expect(reportWithoutExaKey.effectiveConfig.apiKeys.github).toBe('ghp***77');

        const exaStatus = reportWithoutExaKey.engines.find((e) => e.engine === 'exa');
        expect(exaStatus?.status).toBe('missing_api_key');

        const bingStatus = reportWithoutExaKey.engines.find((e) => e.engine === 'bing');
        expect(bingStatus?.status).toBe('configured');
        expect(bingStatus?.networkStatus).toBe('unchecked');

        // Verify network=true mode probes only default required engines (bing, baidu) by default
        const probedDefault: string[] = [];
        const networkReport = await buildDoctorReport(runtime, {
            env: {
                EXA_API_KEY: 'exa-secret-key-88'
            },
            version: '1.0.23-test',
            proxyProbeTimeoutMs: 80,
            network: true,
            networkProbeFn: async (engine) => {
                probedDefault.push(engine);
                return {
                    reachable: engine === 'bing',
                    latencyMs: 12,
                    ...(engine === 'bing' ? {} : { error: 'mock network failure' })
                };
            }
        });
        expect(networkReport.networkChecked).toBe(true);
        expect(typeof networkReport.checkedAt).toBe('string');
        expect(probedDefault).toEqual(['baidu', 'bing']);
        expect(networkReport.probedEngines).toEqual(['baidu', 'bing']);
        expect(networkReport.engines.find((e) => e.engine === 'bing')?.status).toBe('reachable');
        expect(networkReport.engines.find((e) => e.engine === 'baidu')?.status).toBe('unreachable');
        expect(networkReport.engines.find((e) => e.engine === 'sogou')?.networkStatus).toBe('unchecked');

        const stdout: string[] = [];
        const stderr: string[] = [];
        const exitCode = await runCli(
            ['doctor', '--json'],
            runtime,
            {
                stdout: (t) => stdout.push(t),
                stderr: (t) => stderr.push(t)
            }
        );
        expect(exitCode).toBe(0);
        const envelope = JSON.parse(stdout[0]!) as { status: string; data: { engines: unknown[] } };
        expect(envelope.status).toBe('ok');
        expect(Array.isArray(envelope.data.engines)).toBe(true);
    });

    it('supports structured AppError classification, doctor --engine filtering, short-TTL probe cache, and proxyTcp/http/application layering', async () => {
        // 1. Structured AppError classification (code-first, independent of natural language wording)
        const structuredKeyErr = new AppError({
            code: 'missing_api_key',
            retryable: false,
            status: 400,
            engine: 'exa',
            hint: 'Configure EXA_API_KEY',
            message: 'Credential unavailable'
        });
        expect(isRetryableError(structuredKeyErr)).toBe(false);

        const primaryRes = await executePrimaryEngines({
            query: 'structured error test',
            searchQuery: 'structured error test',
            executableEngines: ['exa'],
            limits: [5],
            engineMap: {
                exa: async () => {
                    throw structuredKeyErr;
                }
            },
            deadlineAt: Date.now() + 5000,
            perEngineTimeoutMs: 1000
        });
        expect(primaryRes.partialFailures[0]?.errorCode).toBe('missing_api_key');
        expect(primaryRes.partialFailures[0]?.status).toBe(400);
        expect(primaryRes.partialFailures[0]?.hint).toBe('Configure EXA_API_KEY');
        expect(primaryRes.partialFailures[0]?.retryable).toBe(false);

        // 2. Doctor --engine filtering + proxyTcp / http / application challenge separation + short-TTL probe cache
        clearDoctorProbeCache();
        const proxyTcpServer = http.createServer((_req, res) => {
            res.writeHead(200);
            res.end('ok');
        });
        await new Promise<void>((resolve) => proxyTcpServer.listen(0, '127.0.0.1', () => resolve()));
        const proxyPort = (proxyTcpServer.address() as { port: number }).port;

        try {
            const runtime = createTestRuntime(async () => [], {
                PROXY_URL: `http://127.0.0.1:${proxyPort};duckduckgo,startpage`
            });

            let probeCallCount = 0;
            const probeFn = async (engine: string) => {
                probeCallCount += 1;
                if (engine === 'duckduckgo') {
                    return {
                        reachable: false,
                        http: 'reachable' as const,
                        application: 'challenge' as const,
                        latencyMs: 25,
                        error: 'Upstream anti-bot challenge detected (HTTP 202)'
                    };
                }
                return {
                    reachable: true,
                    http: 'reachable' as const,
                    application: 'ok' as const,
                    latencyMs: 18
                };
            };

            const report1 = await buildDoctorReport(runtime, {
                version: '1.0.23-test',
                network: true,
                engines: ['duckduckgo', 'startpage'],
                probeCacheTtlMs: 10_000,
                networkProbeFn: probeFn
            });

            expect(probeCallCount).toBe(2);
            expect(report1.probedEngines).toEqual(['duckduckgo', 'startpage']);

            const ddg = report1.engines.find((e) => e.engine === 'duckduckgo');
            expect(ddg).toMatchObject({
                engine: 'duckduckgo',
                proxyTcp: 'reachable',
                http: 'reachable',
                application: 'challenge',
                stage: 'challenge',
                status: 'blocked_by_antibot',
                cached: false
            });
            expect(typeof ddg?.checkedAt).toBe('string');
            expect(report1.networkNotice).toContain('Live network probes');

            // Unprobed engines also always include checkedAt, cached, and stage
            const sogou = report1.engines.find((e) => e.engine === 'sogou');
            expect(typeof sogou?.checkedAt).toBe('string');
            expect(sogou?.cached).toBe(false);
            expect(sogou?.stage).toBe('unchecked');

            // Proxy itself is reported reachable because TCP and HTTP forwarding succeeded
            expect(report1.proxy.status).toBe('reachable');

            // Second call within TTL hits probe cache
            const report2 = await buildDoctorReport(runtime, {
                version: '1.0.23-test',
                network: true,
                engines: ['duckduckgo', 'startpage'],
                probeCacheTtlMs: 10_000,
                networkProbeFn: probeFn
            });
            expect(probeCallCount).toBe(2);
            expect(report2.engines.find((e) => e.engine === 'duckduckgo')?.cached).toBe(true);

            // 3. Verify structure parser distinguishes functional vs parse_error on HTTP 200
            expect(
                verifyEngineProbeResponseStructure('bing', 200, '<html><body><ol id="b_results"><li class="b_algo">ok</li></ol></body></html>')
            ).toEqual({ stage: 'functional', application: 'ok' });
            expect(
                verifyEngineProbeResponseStructure('bing', 200, '<html><body><div>Unexpected empty shell</div></body></html>')
            ).toEqual({ stage: 'http_reachable', application: 'parse_error' });

            // 4. Verify doctor --browser real launch probe hook and CLI flag
            let browserProbeCalled = false;
            const browserReport = await buildDoctorReport(runtime, {
                version: '1.0.23-test',
                browser: true,
                browserProbeFn: async (cfg) => {
                    browserProbeCalled = true;
                    return {
                        available: true,
                        status: 'reachable',
                        mode: 'executable',
                        target: '~/msedge.exe',
                        headless: cfg.playwrightHeadless,
                        launched: true,
                        pageOpened: true,
                        latencyMs: 42,
                        error: null
                    };
                }
            });
            expect(browserProbeCalled).toBe(true);
            expect(browserReport.browserChecked).toBe(true);
            expect(browserReport.browser).toMatchObject({
                available: true,
                status: 'reachable',
                launched: true,
                pageOpened: true,
                latencyMs: 42
            });

            // 5. Narrowed string fallback does NOT misclassify normal errors containing words like 'captcha', 'forbidden', or 'anti-bot'
            expect(isRetryableError(new Error('Failed to fetch article about captcha and anti-bot design: socket hang up'))).toBe(true);
            expect(isRetryableError(new Error('Upstream gateway timeout while loading forbidden-planet documentation'))).toBe(true);

            // 6. Quiet startup logs in unit tests by default, DEBUG_TEST_LOGS=true re-enables, and unified desensitization
            expect(shouldEmitConfigStartupLog({ NODE_ENV: 'test' })).toBe(false);
            expect(shouldEmitConfigStartupLog({ NODE_ENV: 'test', DEBUG_TEST_LOGS: 'true' })).toBe(true);
            expect(
                sanitizeUrlForLog('ws://user:pass@127.0.0.1:9222/devtools/browser/abc?token=secret123&api_key=key456')
            ).toBe('ws://***:***@127.0.0.1:9222/devtools/browser/abc?token=***&api_key=***');

            const sanitizedCfg = createConfig(
                {
                    PROXY_URL: 'http://alice:secret@127.0.0.1:7897;bing',
                    PLAYWRIGHT_CDP_ENDPOINT: 'http://127.0.0.1:9222?token=my_cdp_secret'
                },
                { quiet: true }
            );
            const summaryLines = formatSanitizedConfigSummary(sanitizedCfg, { MODE: 'stdio' }).join('\n');
            expect(summaryLines).toContain('http://***:***@127.0.0.1:7897');
            expect(summaryLines).not.toContain('alice:secret');
            expect(summaryLines).toContain('http://127.0.0.1:9222?token=***');
            expect(summaryLines).not.toContain('my_cdp_secret');
        } finally {
            clearDoctorProbeCache();
            proxyTcpServer.close();
        }
    });

    it('propagates AbortSignal cancellation immediately in fetchWebContent instead of swallowing it in cookie or browser fallback catch blocks', async () => {
        const { __setAxiosRequestForTests } = await import('../../utils/httpRequest.js');
        const { __setDnsLookupForTests } = await import('../../utils/urlSafety.js');

        __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
        __setAxiosRequestForTests(async (reqConfig) => ({
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/html; charset=utf-8' },
            data: '<html><head><title>Verify you are human</title></head><body><div class="cf-turnstile"></div></body></html>',
            config: reqConfig,
            request: { res: { responseUrl: 'https://example.com/spa' } }
        } as never));

        const controller = new AbortController();
        let browserFallbackCalled = false;

        __setBrowserCookieHeaderForTests(async () => {
            controller.abort(new Error('user cancelled during cookie stage'));
            throw new Error('user cancelled during cookie stage');
        });
        __setBrowserHtmlFetcherForTests(async () => {
            browserFallbackCalled = true;
            return {
                html: '<html><body><article><p>' + 'A'.repeat(200) + '</p></article></body></html>',
                finalUrl: 'https://example.com/spa',
                title: 'App'
            };
        });

        try {
            await expect(
                fetchWebContent('https://example.com/spa', 3000, {
                    signal: controller.signal
                })
            ).rejects.toThrow(/user cancelled during cookie stage/i);

            // Must NOT proceed to browser HTML fallback after signal was aborted in cookie stage
            expect(browserFallbackCalled).toBe(false);
        } finally {
            __setBrowserCookieHeaderForTests(undefined);
            __setBrowserHtmlFetcherForTests(undefined);
            __setAxiosRequestForTests(undefined);
            __setDnsLookupForTests(undefined);
        }
    });

    it('unifies public error codes, preserves rawCode in details, migrates Context7/Startpage to AppError, and tracks structured_error_rate vs legacy_error_fallback_rate', async () => {
        // 1. Unified public error codes & underlying legacyCode/rawCode in details
        const botErr = new AppError({
            code: 'ERR_BOT_CHALLENGE',
            retryable: false,
            message: 'Anti-bot challenge triggered'
        });
        expect(botErr.code).toBe('bot_challenge');
        expect(botErr.details?.legacyCode).toBe('ERR_BOT_CHALLENGE');
        expect(botErr.details?.rawCode).toBe('ERR_BOT_CHALLENGE');

        const newCodes: AppError['code'][] = [
            'missing_optional_dependency',
            'engine_parse_error',
            'empty_content',
            'upstream_response_invalid',
            'redirect_not_allowed',
            'response_too_large',
            'start_index_out_of_range'
        ];
        for (const code of newCodes) {
            const structuredErr = new AppError({ code, retryable: false });
            expect(structuredErr.code).toBe(code);
            expect(isRetryableError(structuredErr)).toBe(false);
        }

        const timeoutErr = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' });
        expect(extractErrorCode(timeoutErr)).toBe('network_timeout');
        expect(extractErrorDetails(timeoutErr)).toEqual({ rawCode: 'ETIMEDOUT' });

        const resetErr = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        expect(extractErrorCode(resetErr)).toBe('network_error');
        expect(extractErrorDetails(resetErr)).toEqual({ rawCode: 'ECONNRESET' });

        // 2. Context7 & Startpage throw structured AppError
        let ctxEmptyErr: unknown;
        try {
            await searchContext7Libraries('   ', 'react');
        } catch (err) {
            ctxEmptyErr = err;
        }
        expect(isAppError(ctxEmptyErr)).toBe(true);
        expect((ctxEmptyErr as AppError).code).toBe('invalid_arguments');
        expect((ctxEmptyErr as AppError).retryable).toBe(false);

        let ctxIdErr: unknown;
        try {
            await fetchContext7Docs('vercel/next.js', 'routing');
        } catch (err) {
            ctxIdErr = err;
        }
        expect(isAppError(ctxIdErr)).toBe(true);
        expect((ctxIdErr as AppError).code).toBe('invalid_arguments');

        let startpageCaptchaErr: unknown;
        try {
            extractStartpageResults('<html><head><title>Verify you are human</title></head><body>/sp/captcha</body></html>');
        } catch (err) {
            startpageCaptchaErr = err;
        }
        expect(isAppError(startpageCaptchaErr)).toBe(true);
        expect((startpageCaptchaErr as AppError).code).toBe('bot_challenge');
        expect((startpageCaptchaErr as AppError).retryable).toBe(false);

        // 3. Error classification observability: structured_error_rate vs legacy_error_fallback_rate
        resetErrorClassificationMetrics();
        expect(isRetryableError(botErr)).toBe(false);
        expect(isRetryableError(ctxEmptyErr)).toBe(false);
        expect(isRetryableError(new Error('anti-bot challenge page'))).toBe(false);

        const stats = getErrorClassificationMetrics();
        expect(stats.structuredErrorCount).toBe(2);
        expect(stats.legacyErrorFallbackCount).toBe(1);
        expect(stats.legacyFallbackHitCount).toBe(1);
        expect(stats.structured_error_rate).toBeCloseTo(2 / 3, 2);
        expect(stats.legacy_error_fallback_rate).toBeCloseTo(1 / 3, 2);
        expect(metrics.getMetrics().errorClassification.structuredErrorCount).toBe(2);
    });

    it('isolates doctor --browser temporary profile, avoids closing external CDP browser by default, and applies distinct cache TTLs for ok/challenge/failure probes', async () => {
        // 1. CDP mode: does NOT close external browser by default; closes only when DOCTOR_CLOSE_CDP_BROWSER=true
        let cdpBrowserCloseCount = 0;
        let cdpContextCloseCount = 0;
        let cdpPageCloseCount = 0;
        const fakeCdpPlaywright = {
            chromium: {
                connectOverCDP: async () => ({
                    newContext: async () => ({
                        newPage: async () => ({
                            goto: async () => undefined,
                            title: async () => 'my-websearch-doctor',
                            close: async () => { cdpPageCloseCount += 1; }
                        }),
                        close: async () => { cdpContextCloseCount += 1; }
                    }),
                    newPage: async () => ({
                        goto: async () => undefined,
                        title: async () => 'my-websearch-doctor',
                        close: async () => { cdpPageCloseCount += 1; }
                    }),
                    close: async () => { cdpBrowserCloseCount += 1; }
                })
            }
        };

        const cdpConfig = createConfig({
            PLAYWRIGHT_CDP_ENDPOINT: 'http://127.0.0.1:9222?token=secret_cdp_token'
        }, { quiet: true });

        const cdpDefaultRes = await probeBrowserLaunch(cdpConfig, 1000, {
            env: {},
            playwrightClient: fakeCdpPlaywright
        });
        expect(cdpDefaultRes.available).toBe(true);
        expect(cdpDefaultRes.isolatedProfile).toBe(true);
        expect(cdpDefaultRes.browserClosed).toBe(false);
        expect(cdpPageCloseCount).toBe(1);
        expect(cdpContextCloseCount).toBe(1);
        expect(cdpBrowserCloseCount).toBe(0);

        const cdpExplicitCloseRes = await probeBrowserLaunch(cdpConfig, 1000, {
            env: { DOCTOR_CLOSE_CDP_BROWSER: 'true' },
            playwrightClient: fakeCdpPlaywright
        });
        expect(cdpExplicitCloseRes.browserClosed).toBe(true);
        expect(cdpBrowserCloseCount).toBe(1);

        // 2. Executable mode: creates isolated temp profile dir, passes --user-data-dir, and cleans it up in finally
        const dummyExe = path.join(os.tmpdir(), `dummy-browser-${Date.now()}.exe`);
        fs.writeFileSync(dummyExe, 'dummy', 'utf8');
        let capturedLaunchArgs: string[] = [];
        let capturedTempProfileDir = '';
        let profileDirExistedDuringLaunch = false;

        try {
            const fakeExePlaywright = {
                chromium: {
                    launch: async (opts: { args?: string[] }) => {
                        capturedLaunchArgs = opts.args ?? [];
                        const dirArg = capturedLaunchArgs.find((a) => a.startsWith('--user-data-dir='));
                        if (dirArg) {
                            capturedTempProfileDir = dirArg.slice('--user-data-dir='.length);
                            profileDirExistedDuringLaunch = fs.existsSync(capturedTempProfileDir);
                        }
                        return {
                            newPage: async () => ({
                                goto: async () => undefined,
                                title: async () => 'my-websearch-doctor',
                                close: async () => undefined
                            }),
                            close: async () => undefined
                        };
                    }
                }
            };
            const exeConfig = createConfig({
                PLAYWRIGHT_EXECUTABLE_PATH: dummyExe
            }, { quiet: true });

            const exeRes = await probeBrowserLaunch(exeConfig, 1000, {
                playwrightClient: fakeExePlaywright
            });
            expect(exeRes.available).toBe(true);
            expect(exeRes.isolatedProfile).toBe(true);
            expect(exeRes.browserClosed).toBe(true);
            expect(profileDirExistedDuringLaunch).toBe(true);
            expect(capturedTempProfileDir).toContain('my-websearch-doctor-profile-');
            // Temporary profile directory must be deleted after probe completes
            expect(fs.existsSync(capturedTempProfileDir)).toBe(false);
        } finally {
            fs.rmSync(dummyExe, { force: true });
        }

        // 3. Sanitize local browser installation paths in doctor output
        expect(sanitizeBrowserTargetForDoctor('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')).toBe(
            '<system>/Application/msedge.exe'
        );

        // 4. Doctor network probe metadata (probeDuration, probeUserAgent, probeKind, ttlMs, cached) & distinct failure TTL
        clearDoctorProbeCache();
        const runtime = createTestRuntime(async () => []);
        const defaultReport = await buildDoctorReport(runtime, {
            version: '1.0.24-test',
            network: false,
            browser: false,
            engines: ['baidu']
        });
        expect(defaultReport.browser.probeKind).toBe('config_only');
        expect(defaultReport.engines.find((e) => e.engine === 'baidu')?.probeKind).toBe('config_only');

        let baiduCalls = 0;
        const report = await buildDoctorReport(runtime, {
            version: '1.0.24-test',
            network: true,
            engines: ['baidu'],
            probeCacheTtlMs: 30_000,
            challengeProbeCacheTtlMs: 10_000,
            failureProbeCacheTtlMs: 15,
            networkProbeFn: async () => {
                baiduCalls += 1;
                return {
                    reachable: false,
                    http: 'unreachable',
                    application: 'unchecked',
                    latencyMs: 19,
                    error: 'transient failure'
                };
            }
        });
        const baiduEntry = report.engines.find((e) => e.engine === 'baidu');
        expect(baiduEntry?.probeDuration).toBe(19);
        expect(baiduEntry?.probeKind).toBe('http_search');
        expect(baiduEntry?.cached).toBe(false);
        expect(baiduEntry?.ttlMs).toBe(15);
        expect(typeof baiduEntry?.checkedAt).toBe('string');
        expect(typeof baiduEntry?.probeUserAgent).toBe('string');
        expect(report.cachePolicy).toEqual({
            okTtlMs: 30_000,
            challengeTtlMs: 10_000,
            failureTtlMs: 15
        });

        await new Promise((r) => setTimeout(r, 25));
        await buildDoctorReport(runtime, {
            version: '1.0.24-test',
            network: true,
            engines: ['baidu'],
            probeCacheTtlMs: 30_000,
            challengeProbeCacheTtlMs: 10_000,
            failureProbeCacheTtlMs: 15,
            networkProbeFn: async () => {
                baiduCalls += 1;
                return {
                    reachable: true,
                    http: 'reachable',
                    application: 'ok',
                    latencyMs: 11
                };
            }
        });
        expect(baiduCalls).toBe(2);
    });

    it('reduces degraded outcome noise, sets retryable=true on degraded transient failures, filters cascade by query language, aborts sibling cascade on satisfaction, and isolates test config dir', async () => {
        // 1. Test process must NOT read real user home directory config (~/.my-websearch/config.json)
        expect(process.env.MYWEBSEARCH_DATA_DIR).toBeTruthy();
        expect(getAppConfigFilePath(process.env)).toContain('my-websearch-vitest-config-isolated');

        // 2. flattenConfigFileToEnv warns when proxy.url is set alongside useProxy: false
        const warnings: string[] = [];
        const flat = flattenConfigFileToEnv(
            {
                proxy: {
                    url: 'http://127.0.0.1:7897',
                    useProxy: false
                }
            },
            { onWarning: (msg) => warnings.push(msg) }
        );
        expect(flat.PROXY_URL).toBe('false');
        expect(flat.USE_PROXY).toBe('false');
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('proxy.url ("http://127.0.0.1:7897") is configured, but proxy.useProxy is false');

        // 3. computeSearchOutcome: no_results from secondary engine or full requestedLimit reached => outcome='ok'
        expect(
            computeSearchOutcome(5, [{ engine: 'sogou', code: 'no_results', message: '0 results' }], undefined, {
                requestedLimit: 8
            })
        ).toEqual({ outcome: 'ok', retryable: false });

        expect(
            computeSearchOutcome(
                10,
                [{ engine: 'sogou', code: 'engine_error', errorCode: 'network_timeout', retryable: true, message: 'timeout' }],
                undefined,
                { requestedLimit: 10 }
            )
        ).toEqual({ outcome: 'ok', retryable: false });

        // Partial results + retryable hard failure => outcome='degraded', retryable=true
        expect(
            computeSearchOutcome(
                2,
                [{ engine: 'bing', code: 'engine_error', errorCode: 'network_timeout', retryable: true, message: 'Engine timeout' }],
                undefined,
                { requestedLimit: 8, minResults: 5 }
            )
        ).toEqual({ outcome: 'degraded', retryable: true });

        // 4. Language-aware cascade candidate selection: English query does not cascade into baidu/csdn/juejin/sogou
        const fullEngineMap = {
            bing: async () => [],
            baidu: async () => [],
            csdn: async () => [],
            duckduckgo: async () => [],
            brave: async () => [],
            juejin: async () => [],
            startpage: async () => [],
            sogou: async () => []
        };
        const { metrics } = await import('../../core/metrics.js');
        metrics.resetMetrics();

        const enCandidates = pickCascadeCandidates('typescript 5 satisfies operator', new Set(['bing', 'duckduckgo']), fullEngineMap, false);
        expect(enCandidates).toEqual(['brave', 'startpage']);
        expect(enCandidates).not.toContain('baidu');
        expect(enCandidates).not.toContain('csdn');

        const zhCandidates = pickCascadeCandidates('大模型 提示词工程 最佳实践', new Set(['baidu', 'sogou']), fullEngineMap, false);
        expect(zhCandidates.slice(0, 3)).toEqual(['bing', 'juejin', 'csdn']);

        // 4b. Intentional trade-off pinned down: English query + bing already used + overseas unreachable + no EXA_API_KEY -> returns [] (never falls back to Chinese engines)
        const { __setOverseasReachableForTests } = await import('../../utils/overseasProbe.js');
        __setOverseasReachableForTests(false);
        try {
            const noProxyEnCandidates = pickCascadeCandidates('typescript 5 satisfies operator', new Set(['bing']), fullEngineMap, false);
            expect(noProxyEnCandidates).toEqual([]);
        } finally {
            __setOverseasReachableForTests(null);
        }

        // 4c. Dynamic health sorting: engines with recent <50% success rate (total >= 2) are demoted behind healthy candidates
        metrics.resetMetrics();
        metrics.recordEngineSearch('duckduckgo', 10000, false);
        metrics.recordEngineSearch('duckduckgo', 10000, false);
        try {
            const healthSorted = pickCascadeCandidates('typescript 5 satisfies operator', new Set(['bing']), fullEngineMap, false);
            expect(healthSorted).toEqual(['brave', 'startpage', 'duckduckgo']);
        } finally {
            metrics.resetMetrics();
        }

        // 4d. Case 2 vs Case 3 in computeSearchOutcome:
        // Case 2: totalResults >= requestedLimit returns ok even when primary engine had a hard failure
        expect(computeSearchOutcome(10, [
            { engine: 'bing', code: 'engine_error', errorCode: 'network_timeout', retryable: true, message: 'timeout' }
        ], undefined, { requestedLimit: 10, minResults: 5, primaryEngines: ['bing'] })).toEqual({
            outcome: 'ok',
            retryable: false
        });
        // Case 3: minResults <= totalResults < requestedLimit returns degraded when primary engine had a hard failure,
        //         but returns ok when only a cascade engine had a hard failure
        expect(computeSearchOutcome(5, [
            { engine: 'bing', code: 'engine_error', errorCode: 'network_timeout', retryable: true, message: 'timeout' }
        ], undefined, { requestedLimit: 10, minResults: 5, primaryEngines: ['bing'] })).toEqual({
            outcome: 'degraded',
            retryable: true
        });
        expect(computeSearchOutcome(5, [
            { engine: 'startpage', code: 'engine_error', errorCode: 'network_timeout', retryable: true, message: 'timeout' }
        ], undefined, { requestedLimit: 10, minResults: 5, primaryEngines: ['bing'] })).toEqual({
            outcome: 'ok',
            retryable: false
        });

        // 5. In-batch early cancellation with cascade_aborted sentinel: when fast candidate in batch satisfies minResults, slow sibling is aborted immediately with cascade_aborted
        const { isCascadeAbortedError, isAbortedError } = await import('../../core/errors.js');
        let slowSiblingAborted = false;
        let slowSiblingAbortReason: unknown;
        const cascadeStarted = Date.now();
        const cascadeRes = await executeCascade({
            cleanQuery: 'typescript 5 satisfies',
            searchQuery: 'typescript 5 satisfies',
            minResults: 2,
            initialMerged: [],
            initialEngineResults: [],
            engines: ['bing'],
            engineMap: {
                duckduckgo: async () => [
                    { title: 'TypeScript 5 satisfies operator guide', url: 'https://ts.dev/1', description: 'typescript 5 satisfies', source: 'ts.dev', engine: 'duckduckgo' },
                    { title: 'TypeScript 5 satisfies deep dive', url: 'https://ts.dev/2', description: 'typescript 5 satisfies examples', source: 'ts.dev', engine: 'duckduckgo' }
                ],
                brave: async (_q, _l, ctx) => new Promise((_resolve, reject) => {
                    ctx?.signal?.addEventListener('abort', () => {
                        slowSiblingAborted = true;
                        slowSiblingAbortReason = ctx?.signal?.reason;
                        reject(ctx?.signal?.reason ?? new Error('aborted'));
                    }, { once: true });
                })
            },
            deadlineAt: Date.now() + 5000,
            perEngineTimeoutMs: 3000
        });
        expect(Date.now() - cascadeStarted).toBeLessThan(1000);
        expect(slowSiblingAborted).toBe(true);
        expect(isCascadeAbortedError(slowSiblingAbortReason)).toBe(true);
        expect(isAbortedError(slowSiblingAbortReason)).toBe(true);
        expect(cascadeRes.merged.length).toBe(2);
        expect(cascadeRes.cascadeFailures).toEqual([]);

        // 6. Per-batch overseas reachability re-filtering: if Batch 1 marks overseas unreachable, Batch 2 skips startpage immediately
        let startpageCalled = false;
        __setOverseasReachableForTests(null);
        try {
            await executeCascade({
                cleanQuery: 'typescript 5 satisfies',
                searchQuery: 'typescript 5 satisfies',
                minResults: 2,
                initialMerged: [],
                initialEngineResults: [],
                engines: ['bing'],
                engineMap: {
                    duckduckgo: async () => {
                        __setOverseasReachableForTests(false);
                        return [];
                    },
                    brave: async () => [],
                    startpage: async () => {
                        startpageCalled = true;
                        return [];
                    }
                },
                deadlineAt: Date.now() + 5000,
                perEngineTimeoutMs: 3000
            });
            expect(startpageCalled).toBe(false);
        } finally {
            __setOverseasReachableForTests(null);
        }
    });
});

