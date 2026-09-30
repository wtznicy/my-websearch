// my-websearch MCP Live 评测套件
// 通过 stdio JSON-RPC 与 build/index.js 通信，逐用例计时，覆盖 7 个工具与 22 个用例。
// 用法: node tools/runLiveEval.mjs [filter]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(ROOT, 'build', 'index.js');

const filter = process.argv[2] || '';

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
            USE_PROXY: process.env.USE_PROXY || 'true',
            PROXY_URL: process.env.PROXY_URL || 'http://127.0.0.1:7890',
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
    { id: 'fetch-web-zhihu', tool: 'fetchWebContent', args: { url: 'https://zhuanlan.zhihu.com/p/669789440', maxChars: 3000 } },
    { id: 'fetch-csdn', tool: 'fetchCsdnArticle', args: { url: 'https://blog.csdn.net/qq_43061290/article/details/126651783' } },
    { id: 'fetch-juejin', tool: 'fetchJuejinArticle', args: { url: 'https://juejin.cn/post/7115474775136272392' } },
    { id: 'fetch-github', tool: 'fetchGithubReadme', args: { url: 'https://github.com/modelcontextprotocol/servers' } },
    { id: 'resolve-lib', tool: 'resolveLibraryId', args: { libraryName: 'react', query: 'hooks' } },
    // —— 安全与错误处理 ——
    { id: 'ssrf-loopback', tool: 'fetchWebContent', args: { url: 'http://127.0.0.1:18080/secret', maxChars: 500 }, expectError: true },
    { id: 'ssrf-private-ip', tool: 'fetchWebContent', args: { url: 'http://192.168.1.1/admin', maxChars: 500 }, expectError: true },
    { id: 'ssrf-decimal-ip', tool: 'fetchWebContent', args: { url: 'http://2130706433/', maxChars: 500 }, expectError: true },
    { id: 'err-invalid-engine', tool: 'search', args: { query: 'test', engines: ['nonexistent-engine'] }, expectError: true },
    { id: 'err-fetch-404', tool: 'fetchWebContent', args: { url: 'https://httpbin.org/status/404', maxChars: 500 }, expectError: true },
    { id: 'err-csdn-soft-404', tool: 'fetchCsdnArticle', args: { url: 'https://blog.csdn.net/weixin_43881394/article/details/132572757' }, expectError: true },
];

function summarize(tool, result) {
    const text = result?.content?.[0]?.text ?? '';
    const isError = result?.isError === true;
    if (tool === 'search') {
        try {
            const data = JSON.parse(text);
            return {
                isError,
                results: data.totalResults ?? 0,
                engines: (data.engines || []).join(','),
                failures: (data.partialFailures || []).map(f => f.engine).join(',') || '-',
                firstTitle: data.results?.[0]?.title?.slice(0, 40) || '-'
            };
        } catch {
            return { isError, results: '-', engines: '-', failures: '-', firstTitle: text.slice(0, 60) };
        }
    }
    // fetch 类
    if (isError) return { isError, bytes: 0, note: text.split('\n')[0].slice(0, 80) };
    return { isError, bytes: text.length, note: text.slice(0, 60).replace(/\n/g, ' ') };
}

async function main() {
    console.log('🚀 启动 MCP server 活体评测 (MODE=stdio, USE_PROXY=true)...\n');
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
            const sum = summarize(c.tool, result);
            const ok = c.expectError ? sum.isError : !sum.isError;
            outcome = { id: c.id, ms, ok, ...sum };
        } catch (e) {
            outcome = { id: c.id, ms: Date.now() - started, ok: false, error: String(e).slice(0, 120) };
        }
        report.push(outcome);
        const status = outcome.ok ? '✅ PASS' : '❌ FAIL';
        const extra = outcome.results !== undefined
            ? `results=${outcome.results} engines=${outcome.engines} fail=${outcome.failures}`
            : (outcome.note || outcome.error || '');
        console.log(`[${status}] ${outcome.id.padEnd(24)} ${String(outcome.ms).padStart(6)}ms  ${extra}`);
    }

    server.child.kill('SIGTERM');
    setTimeout(() => server.child.kill('SIGKILL'), 2000).unref();

    const failed = report.filter(r => !r.ok);
    console.log(`\n==== 评测汇总: ${report.length - failed.length}/${report.length} 通过 ====`);
    if (failed.length > 0) {
        for (const f of failed) console.log('  失败:', f.id, f.error || f.note || '');
    }
    const outDir = path.join(ROOT, '.workbuddy', 'eval');
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    const outPath = path.join(outDir, 'eval-live-report.json');
    fs.writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), toolNames, report }, null, 2));
    console.log('📄 评测报告已保存至:', outPath);
    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
