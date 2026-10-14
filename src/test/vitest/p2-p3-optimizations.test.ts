import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidBingTargetHostname, sanitizeBingUrl } from '../../engines/bing/parser.js';
import { rankSearchResults } from '../../core/search/resultRanking.js';
import { detectLlmMarkdownUrl } from '../../engines/web/fetchWebContent.js';
import { stripTrailingDocFooterNoise } from '../../utils/markdown.js';
import { buildFetchWebErrorHint } from '../../tools/toolShared.js';
import { resetAllHealthState, clearDoctorProbeCache, buildDoctorReport } from '../../cli/doctor.js';
import { isEngineCircuitOpen, tripEngineCircuit, resetEngineCircuits } from '../../core/search/engineCircuitBreaker.js';
import { isBingImpersonateCircuitOpen, recordBingImpersonateFailure } from '../../engines/bing/impersonate.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchTool } from '../../tools/handlers/searchTool.js';
import { registerFetchWebTool } from '../../tools/handlers/fetchWebTool.js';
import { registerFetchGithubTool } from '../../tools/handlers/fetchGithubTool.js';
import { registerFetchCsdnTool } from '../../tools/handlers/fetchCsdnTool.js';
import { registerFetchJuejinTool } from '../../tools/handlers/fetchJuejinTool.js';
import { registerResolveLibraryTool } from '../../tools/handlers/resolveLibraryTool.js';
import { registerQueryDocsTool } from '../../tools/handlers/queryDocsTool.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';

describe('P2 & P3 Optimizations', () => {
    describe('P2-2: Authority score requires query match in rankSearchResults', () => {
        it('does not grant domain authority score to pages that do not match query tokens', () => {
            const results = [
                {
                    title: 'Welcome to nginx!',
                    url: 'https://scs.gov.cn/nginx.html',
                    description: 'Default nginx welcome page on gov server',
                    source: 'scs.gov.cn',
                    engine: 'bing'
                },
                {
                    title: 'Kubernetes Official Documentation',
                    url: 'https://example.com/docs/kubernetes',
                    description: 'Getting started with kubernetes cluster orchestration',
                    source: 'example.com',
                    engine: 'bing'
                }
            ];

            const ranked = rankSearchResults(results, 'kubernetes deployment guide');
            // The kubernetes page should be ranked #1 because scs.gov.cn does not match any query token and should not get authority bonus
            expect(ranked[0]?.title).toBe('Kubernetes Official Documentation');
        });
    });

    describe('P2-3: Bing parser hostname validation', () => {
        it('rejects malformed hostnames with leading underscores or invalid characters', () => {
            expect(isValidBingTargetHostname('_www.hellofont.cn')).toBe(false);
            expect(isValidBingTargetHostname('..invalid.com')).toBe(false);
            expect(isValidBingTargetHostname('invalid..com')).toBe(false);
            expect(isValidBingTargetHostname('plainhost')).toBe(false);
            expect(isValidBingTargetHostname('www.example.123')).toBe(false);

            expect(isValidBingTargetHostname('www.example.com')).toBe(true);
            expect(isValidBingTargetHostname('sub.domain.org.cn')).toBe(true);
        });

        it('sanitizeBingUrl returns empty string for malformed hostname', () => {
            expect(sanitizeBingUrl('https://_www.hellofont.cn/font/123')).toBe('');
            expect(sanitizeBingUrl('https://www.example.com/page?ref=123')).toBe('https://www.example.com/page');
        });
    });

    describe('P2-4: detectLlmMarkdownUrl alternate detection', () => {
        it('detects <link rel="alternate" type="text/markdown"> with same-origin .md URL', () => {
            const html = `<html><head><link rel="alternate" type="text/markdown" href="/docs/guide.md"></head><body><h1>Docs</h1></body></html>`;
            const detected = detectLlmMarkdownUrl(html, 'Docs text', 'https://vuejs.org/guide/introduction.html');
            expect(detected).toBe('https://vuejs.org/docs/guide.md');
        });

        it('detects leading LLM reading hints in doc pages', () => {
            const html = `<div>Are you an LLM? You can read better optimized documentation at /guide/computed.md</div>`;
            const text = 'Are you an LLM? You can read better optimized documentation at /guide/computed.md';
            const detected = detectLlmMarkdownUrl(html, text, 'https://vuejs.org/guide/computed.html');
            expect(detected).toBe('https://vuejs.org/guide/computed.md');
        });

        it('ignores external origin or non-markdown URLs', () => {
            const html = `<div>Are you an LLM? You can read at https://malicious.com/stealer.md</div>`;
            const detected = detectLlmMarkdownUrl(html, '', 'https://vuejs.org/guide/computed.html');
            expect(detected).toBeNull();
        });
    });

    describe('P2-5: stripTrailingDocFooterNoise', () => {
        it('strips MDN and GitHub doc footer noise', () => {
            const rawMd = `# Array.prototype.map()\n\nThe map method...\n\n### Help improve MDN\n\nWas this page helpful?\n[Report a problem with this content on GitHub](https://github.com/mdn/content)`;
            const stripped = stripTrailingDocFooterNoise(rawMd);
            expect(stripped).toContain('The map method...');
            expect(stripped).not.toContain('Help improve MDN');
            expect(stripped).not.toContain('Report a problem with this content on GitHub');
        });
    });

    describe('P2-6 & P2-7: buildFetchWebErrorHint specific guidance', () => {
        it('returns accurate hint for startIndex out of range including totalLength', () => {
            const error = new Error('startIndex 5000 is beyond content length 2400');
            const hint = buildFetchWebErrorHint(error);
            expect(hint).toContain('startIndex (5000) 超出正文实际总长度（totalLength=2400）');
            expect(hint).not.toContain('可降低 maxChars');
        });

        it('returns accurate hint for PDF binary rejection', () => {
            const error = new Error('PDF binary files (application/pdf) are not supported by fetchWebContent');
            const hint = buildFetchWebErrorHint(error);
            expect(hint).toContain('目标地址为 PDF 二进制文件');
            expect(hint).toContain('降低 maxChars 不会改变 2MB 下载体积上限');
        });

        it('returns accurate hint for ERR_RESPONSE_TOO_LARGE', () => {
            const error = new Error('Response body too large (3000000 bytes). Max allowed is 2097152 bytes');
            const hint = buildFetchWebErrorHint(error);
            expect(hint).toContain('目标响应体超过 2MB 下载硬上限');
        });
    });

    describe('P3-3: server.registerTool registration across all MCP tools', () => {
        it('successfully registers all 7 tools using server.registerTool', () => {
            const server = new McpServer({ name: 'test', version: '1.0.0' });
            const runtime = createMyWebSearchRuntime();

            registerSearchTool(server, runtime);
            registerFetchWebTool(server, runtime);
            registerFetchGithubTool(server, runtime);
            registerFetchCsdnTool(server, runtime);
            registerFetchJuejinTool(server, runtime);
            registerResolveLibraryTool(server, runtime);
            registerQueryDocsTool(server, runtime);

            // Verify tools are registered in server
            const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
            expect(registered).toBeDefined();
            expect(registered['search']).toBeDefined();
            expect(registered['fetchWebContent']).toBeDefined();
            expect(registered['fetchGithubReadme']).toBeDefined();
            expect(registered['fetchCsdnArticle']).toBeDefined();
            expect(registered['fetchJuejinArticle']).toBeDefined();
            expect(registered['resolveLibraryId']).toBeDefined();
            expect(registered['queryDocs']).toBeDefined();
        });
    });

    describe('P3-7: resetAllHealthState and doctor --reset-health', () => {
        it('resets circuit breakers and impersonate breakers', async () => {
            const runtime = createMyWebSearchRuntime();

            // Trip engine circuit breaker
            tripEngineCircuit('baidu');
            expect(isEngineCircuitOpen('baidu')).toBe(true);

            // Trip Bing impersonate circuit breaker
            recordBingImpersonateFailure();
            recordBingImpersonateFailure();
            expect(isBingImpersonateCircuitOpen()).toBe(true);

            // Reset health state
            resetAllHealthState(runtime);

            expect(isEngineCircuitOpen('baidu')).toBe(false);
            expect(isBingImpersonateCircuitOpen()).toBe(false);
        });

        it('buildDoctorReport with resetHealth=true executes reset and marks healthReset in report', async () => {
            const runtime = createMyWebSearchRuntime();
            tripEngineCircuit('sogou');
            expect(isEngineCircuitOpen('sogou')).toBe(true);

            const report = await buildDoctorReport(runtime, {
                resetHealth: true,
                network: false,
                browser: false
            });

            expect(report.healthReset).toBe(true);
            expect(isEngineCircuitOpen('sogou')).toBe(false);
        });
    });
});
