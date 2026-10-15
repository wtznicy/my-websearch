// my-websearch MCP Live 评测套件
// 通过 stdio JSON-RPC 与 build/index.js 通信，逐用例计时，覆盖 7 个工具与 22 个用例。
// 用法: node tools/runLiveEval.mjs [filter]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(ROOT, 'build', 'index.js');

const rawArgs = process.argv.slice(2);
const isDirectMode = rawArgs.includes('--direct') || rawArgs.includes('--no-proxy');
const isAutoMode = rawArgs.includes('--auto');
const proxyArg = rawArgs.find(a => a.startsWith('--proxy='));
const customProxy = proxyArg ? proxyArg.split('=')[1] : null;
const filter = rawArgs.find(a => !a.startsWith('--')) || '';

let evalProxyUrl;
if (isDirectMode) {
    evalProxyUrl = 'direct';
} else if (isAutoMode) {
    evalProxyUrl = '';
} else if (customProxy) {
    evalProxyUrl = customProxy;
} else if (process.env.PROXY_URL !== undefined) {
    evalProxyUrl = process.env.PROXY_URL;
} else {
    evalProxyUrl = '';
}

try {
    const { loadApplicationConfigEnv } = await import('../build/configLoader.js');
    loadApplicationConfigEnv(process.env, { quiet: true });
} catch {
    // build 未生成时忽略
}

// ---- MCP stdio 客户端 ----
function startServer(env = {}) {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
        env: {
            ...process.env,
            MODE: 'stdio',
            PROXY_URL: evalProxyUrl,
            LOG_LEVEL: 'quiet',
            ...env
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let buffer = '';
    const pending = new Map();
    let nextId = 1;
    const stderrLines = [];
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id !== undefined && pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
            }
        }
    });
    child.stderr.on('data', (chunk) => {
        stderrLines.push(chunk.toString('utf8'));
        if (stderrLines.length > 50) stderrLines.shift();
    });
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method}`));
        }, 120000);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const notify = (method, params) => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    };
    return { child, call, notify, stderrLines };
}

async function initSession(env) {
    const server = startServer(env);
    const initRes = await server.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'runLiveEval', version: '1.0.0' }
    });
    server.notify('notifications/initialized', {});
    const tools = await server.call('tools/list', {});
    return { server, initRes, tools };
}

// ---- 用例定义 ----
const cases = [
    // —— 国内引擎（直连）——
    { id: 'search-bing-zh', tool: 'search', args: { query: 'Model Context Protocol 教程', engines: ['bing'], limit: 8 } },
    { id: 'search-baidu', tool: 'search', args: { query: 'MCP 服务器 开发', engines: ['baidu'], limit: 8 } },
    { id: 'search-sogou', tool: 'search', args: { query: '微信 小程序 云开发', engines: ['sogou'], limit: 8 } },
    { id: 'search-csdn', tool: 'search', args: { query: 'TypeScript 类型体操', engines: ['csdn'], limit: 8 } },
    { id: 'search-juejin', tool: 'search', args: { query: '前端工程化 实践', engines: ['juejin'], limit: 8 } },
    // —— 海外引擎（走代理）——
    { id: 'search-ddg', tool: 'search', args: { query: 'model context protocol servers', engines: ['duckduckgo'], limit: 8 } },
    { id: 'search-brave', tool: 'search', args: { query: 'model context protocol specification', engines: ['brave'], limit: 8 } },
    { id: 'search-startpage', tool: 'search', args: { query: 'anthropic model context protocol', engines: ['startpage'], limit: 8 } },
    // —— 路由/级联 ——
    { id: 'search-auto-zh', tool: 'search', args: { query: '大模型 提示词工程 最佳实践', limit: 8 } },
    { id: 'search-auto-en', tool: 'search', args: { query: 'rust async runtime comparison', limit: 8 } },
    { id: 'search-multi-query', tool: 'search', args: { queries: ['MCP 协议 中文教程', 'model context protocol docs'], limit: 8 } },
    // —— 正文/文档抓取 ——
    { id: 'fetch-web-zhihu', tool: 'fetchWebContent', args: { url: 'https://zhuanlan.zhihu.com/p/669789440', maxChars: 3000 }, allowBotChallenge: true },
    { id: 'fetch-csdn', tool: 'fetchCsdnArticle', args: { url: 'https://blog.csdn.net/qq_43061290/article/details/126651783' } },
    { id: 'fetch-juejin', tool: 'fetchJuejinArticle', args: { url: 'https://juejin.cn/post/7115474775136272392' } },
    { id: 'fetch-github', tool: 'fetchGithubReadme', args: { url: 'https://github.com/modelcontextprotocol/servers' } },
    { id: 'resolve-lib', tool: 'resolveLibraryId', args: { libraryName: 'react', query: 'hooks' } },
    { id: 'query-docs', tool: 'queryDocs', args: { libraryId: '/facebook/react', query: 'useState hooks', limit: 3 } },
    // —— 安全与错误处理 ——
    { id: 'ssrf-loopback', tool: 'fetchWebContent', args: { url: 'http://127.0.0.1:18080/secret', maxChars: 3000 }, expectError: true, expectedErrorPattern: /public HTTP|private or local|loopback|not allowed/i },
    { id: 'ssrf-private-ip', tool: 'fetchWebContent', args: { url: 'http://192.168.1.1/admin', maxChars: 3000 }, expectError: true, expectedErrorPattern: /public HTTP|private or local|not allowed/i },
    { id: 'ssrf-decimal-ip', tool: 'fetchWebContent', args: { url: 'http://2130706433/', maxChars: 3000 }, expectError: true, expectedErrorPattern: /public HTTP|private or local|not allowed/i },
    { id: 'err-invalid-engine', tool: 'search', args: { query: 'test', engines: ['nonexistent-engine'] }, expectError: true, expectedErrorPattern: /invalid_enum_value|Unsupported|invalid.*engine|nonexistent-engine/i },
    { id: 'err-fetch-404', tool: 'fetchWebContent', args: { url: 'https://httpbin.org/status/404', maxChars: 3000 }, expectError: true, expectedErrorPattern: /404|status code/i },
    { id: 'err-csdn-soft-404', tool: 'fetchCsdnArticle', args: { url: 'https://blog.csdn.net/weixin_43881394/article/details/132572757' }, expectError: true, expectedErrorPattern: /404|不存在|已删除/i },
];

function summarize(tool, result, rpcError) {
    if (rpcError) {
        const msg = typeof rpcError.message === 'string' ? rpcError.message : JSON.stringify(rpcError);
        return {
            isError: true,
            rpcError: true,
            note: `JSON-RPC error: ${msg.slice(0, 80)}`
        };
    }
    const text = result?.content?.[0]?.text ?? '';
    const isError = result?.isError === true;
    if (tool === 'search') {
        try {
            const data = JSON.parse(text);
            const partialFailures = Array.isArray(data.partialFailures) ? data.partialFailures : [];
            return {
                isError,
                outcome: data.outcome ?? (data.totalResults > 0 ? 'ok' : 'empty'),
                retryable: Boolean(data.retryable),
                results: data.totalResults ?? 0,
                engines: (data.engines || []).join(','),
                failures: partialFailures.map(f => f.engine).join(',') || '-',
                failureCodes: partialFailures.map(f => f.errorCode || f.code).filter(Boolean).join(',') || '-',
                failureMessages: partialFailures.map(f => f.message || '').join(' | '),
                firstTitle: data.results?.[0]?.title?.slice(0, 40) || '-'
            };
        } catch {
            return { isError, outcome: 'failed', results: 0, engines: '-', failures: '-', firstTitle: text.slice(0, 60) };
        }
    }
    // fetch 类
    if (isError) return { isError, bytes: 0, note: text.split('\n')[0].slice(0, 80) };
    return { isError, bytes: text.length, note: text.slice(0, 60).replace(/\n/g, ' ') };
}

function classifyFailureType(tool, sum, text, rpcError) {
    const combined = [
        text || '',
        sum?.note || '',
        sum?.failureCodes || '',
        sum?.failureMessages || '',
        rpcError ? JSON.stringify(rpcError) : ''
    ].join(' ');

    if (/ERR_BOT_CHALLENGE|bot_challenge|anti-bot|captcha|verify you are human|security check|目标站点触发反爬验证|没有知识存在的荒原/i.test(combined)) {
        return 'upstream_antibot';
    }
    if (/missing_api_key|EXA_API_KEY|CONTEXT7_API_KEY|BRAVE_API_KEY|unauthorized|\b401\b/i.test(combined)) {
        return 'config_failure';
    }
    if (/invalid_enum_value|invalid_arguments|Invalid arguments|Unsupported search engine|public HTTP|private or local|loopback|not allowed/i.test(combined)) {
        return 'validation_failure';
    }
    if (
        /timeout|timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|overseas_unreachable|proxy|\b50[234]\b/i.test(combined)
    ) {
        return 'network_failure';
    }
    if (
        /engine_parse_error|empty_content|upstream_response_invalid/i.test(combined)
        || (tool === 'search' && (sum?.outcome === 'empty' || (!sum?.isError && sum?.results === 0)))
        || (tool !== 'search' && !sum?.isError && (!text || text.trim().length < 40))
    ) {
        return 'parser_failure';
    }
    return 'network_failure';
}

function hasSubstantiveFetchedContent(text) {
    if (!text || text.trim().length < 40) {
        return false;
    }
    if (/你似乎来到了没有知识存在的荒原|安全验证\s*-\s*知乎|环境异常.*完成验证后即可继续访问/i.test(text)) {
        return false;
    }
    return true;
}

async function main() {
    console.log(`🚀 启动 MCP server 活体评测 (MODE=stdio, PROXY_URL="${evalProxyUrl}")...\n`);
    const { server, tools } = await initSession();
    const toolNames = (tools.result?.tools || []).map(t => t.name);
    console.log('📋 已注册工具:', toolNames.join(', '), '\n');

    const report = [];
    for (const c of cases) {
        if (filter && !c.id.includes(filter)) continue;
        const started = Date.now();
        let outcome;
        try {
            const res = await server.call('tools/call', { name: c.tool, arguments: c.args });
            const ms = Date.now() - started;
            const result = res.result;
            const sum = summarize(c.tool, result, res.error);
            const text = result?.content?.[0]?.text ?? '';
            const isBotChallenge = text.includes('bot_challenge') || text.includes('ERR_BOT_CHALLENGE') || text.includes('目标站点触发反爬验证');
            let ok = false;
            let category = 'failed';
            let failureType = null;

            if (c.expectError) {
                const errorMessage = res.error
                    ? (typeof res.error.message === 'string' ? res.error.message : JSON.stringify(res.error))
                    : text;
                const patternMatched = !c.expectedErrorPattern || c.expectedErrorPattern.test(errorMessage);
                ok = sum.isError && patternMatched;
                category = ok ? 'expected_error_pass' : 'validation_failure';
                if (!ok) {
                    failureType = 'validation_failure';
                }
                if (sum.isError && !patternMatched) {
                    sum.note = `unexpected error reason (expected ${c.expectedErrorPattern}): ${errorMessage.slice(0, 80)}`;
                }
            } else if (c.tool === 'search') {
                ok = !sum.isError && typeof sum.results === 'number' && sum.results > 0 && sum.outcome !== 'failed';
                if (ok) {
                    category = sum.outcome === 'degraded' ? 'degraded_pass' : 'functional_pass';
                } else {
                    failureType = classifyFailureType(c.tool, sum, text, res.error);
                    category = failureType;
                    if (!sum.note) {
                        sum.note = `search returned results=${sum.results}, outcome=${sum.outcome}`;
                    }
                }
            } else {
                const contentValid = !sum.isError && hasSubstantiveFetchedContent(text);
                if (contentValid) {
                    ok = true;
                    category = 'functional_pass';
                } else if (c.allowBotChallenge && isBotChallenge) {
                    ok = true;
                    category = 'bot_challenge_detected';
                    failureType = 'upstream_antibot';
                    sum.note = 'bot_challenge / ERR_BOT_CHALLENGE (反爬挑战已准确识别并拦截，非正文提取通过)';
                } else {
                    ok = false;
                    failureType = classifyFailureType(c.tool, sum, text, res.error);
                    category = failureType;
                }
            }
            outcome = {
                id: c.id,
                expectError: Boolean(c.expectError),
                ms,
                ok,
                category,
                ...(failureType ? { failureType } : {}),
                ...sum
            };
        } catch (e) {
            outcome = {
                id: c.id,
                expectError: Boolean(c.expectError),
                ms: Date.now() - started,
                ok: false,
                category: 'network_failure',
                failureType: 'network_failure',
                error: String(e).slice(0, 120)
            };
        }
        report.push(outcome);
        const status = !outcome.ok
            ? `❌ FAIL(${outcome.failureType || outcome.category})`
            : outcome.category === 'bot_challenge_detected'
                ? '⚠️ BOT_CHALLENGE'
                : '✅ PASS';
        const extra = outcome.results !== undefined
            ? `outcome=${outcome.outcome} results=${outcome.results} engines=${outcome.engines} fail=${outcome.failures}`
            : (outcome.note || outcome.error || '');
        console.log(`[${status}] ${outcome.id.padEnd(24)} ${String(outcome.ms).padStart(6)}ms  ${extra}`);
    }

    server.child.kill('SIGTERM');
    setTimeout(() => server.child.kill('SIGKILL'), 2000).unref();

    const failed = report.filter(r => !r.ok);
    const functionalCases = report.filter(r => !r.expectError);
    const expectedErrorCases = report.filter(r => r.expectError);
    const functionalPassed = report.filter(r => r.category === 'functional_pass' || r.category === 'degraded_pass');
    const expectedErrorPassed = report.filter(r => r.category === 'expected_error_pass');
    const botChallengeDetected = report.filter(r => r.category === 'bot_challenge_detected');
    const securityAndAntiBotTotal = expectedErrorCases.length + botChallengeDetected.length;
    const securityAndAntiBotPassed = expectedErrorPassed.length + botChallengeDetected.length;
    const functionalSuccessRate = functionalCases.length > 0
        ? `${functionalPassed.length} / ${functionalCases.length}`
        : '0 / 0';
    const securityAndAntiBotDetectionRate = securityAndAntiBotTotal > 0
        ? `${securityAndAntiBotPassed} / ${securityAndAntiBotTotal}`
        : '0 / 0';
    const failureBreakdown = {
        network_failure: failed.filter(r => r.failureType === 'network_failure').length,
        upstream_antibot: failed.filter(r => r.failureType === 'upstream_antibot').length,
        parser_failure: failed.filter(r => r.failureType === 'parser_failure').length,
        config_failure: failed.filter(r => r.failureType === 'config_failure').length,
        validation_failure: failed.filter(r => r.failureType === 'validation_failure').length
    };

    console.log(`\n==== 评测汇总: ${report.length - failed.length}/${report.length} 断言通过 ====`);
    console.log(`  - 功能成功率: ${functionalSuccessRate}`);
    console.log(`  - 安全/反爬识别率: ${securityAndAntiBotDetectionRate}`);
    console.log(`  - 功能正向通过: ${functionalPassed.length}`);
    console.log(`  - 预期错误拦截: ${expectedErrorPassed.length}`);
    console.log(`  - 反爬挑战识别 (非正文提取): ${botChallengeDetected.length}`);
    console.log(`  - 失败用例: ${failed.length} (network=${failureBreakdown.network_failure}, antibot=${failureBreakdown.upstream_antibot}, parser=${failureBreakdown.parser_failure}, config=${failureBreakdown.config_failure}, validation=${failureBreakdown.validation_failure})`);
    if (failed.length > 0) {
        for (const f of failed) console.log(`  失败 [${f.failureType || f.category}]:`, f.id, f.error || f.note || '');
    }
    const outDir = path.join(ROOT, '.workbuddy', 'eval');
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    const outPath = path.join(outDir, 'eval-live-report.json');
    fs.writeFileSync(
        outPath,
        JSON.stringify(
            {
                timestamp: new Date().toISOString(),
                summary: {
                    total: report.length,
                    passed: report.length - failed.length,
                    functionalTotal: functionalCases.length,
                    functionalPassed: functionalPassed.length,
                    functionalSuccessRate,
                    securityAndAntiBotTotal,
                    securityAndAntiBotPassed,
                    securityAndAntiBotDetectionRate,
                    expectedErrorPassed: expectedErrorPassed.length,
                    botChallengeDetected: botChallengeDetected.length,
                    failed: failed.length,
                    failureBreakdown
                },
                toolNames,
                report
            },
            null,
            2
        )
    );
    console.log('📄 评测报告已保存至:', outPath);
    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });

