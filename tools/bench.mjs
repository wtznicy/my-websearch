#!/usr/bin/env node
/**
 * 性能基准：给「改代码到底有没有变快」提供一个可重复的基线。
 *
 *   npm run build && node tools/bench.mjs               # 抓取 + 搜索
 *   node tools/bench.mjs --only fetch --runs 5
 *   node tools/bench.mjs --json                         # 机器可读
 *
 * 为什么要有它：metrics 里只有 per-engine 平均耗时，没有阶段拆分。
 * 没有基线就不知道优化省的是 10% 还是 40%，所以先测再改。
 *
 * 抓取套件同时跑两条路径：
 *   - app：fetchWebContent() 全流程（含解析/转换）
 *   - raw：单次 GET 的 DNS/TCP/TLS/TTFB/body 分项（不含 HEAD、不含解析）
 * 两者之差 ≈ 应用层开销（历史实现里还包含一次 HEAD 往返）。
 */

import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toImportSpecifier = (absolutePath) => pathToFileURL(absolutePath).href;
const BUILD_ENTRY = path.join(ROOT, 'build', 'engines', 'web', 'fetchWebContent.js');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const RUNS = Number(flag('runs', '3'));
const ONLY = flag('only', 'all');
const JSON_OUT = args.includes('--json');

const FETCH_URLS = [
    'https://example.com',
    'https://quotes.toscrape.com/',
    'https://docs.python.org/3/library/os.html'
];

const SEARCH_QUERIES = [
    'nodejs stream backpressure',
    'Python asyncio 超时 取消'
];

// ── 统计 ───────────────────────────────────────────────────────────────────

const pct = (values, p) => {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[index];
};

const stats = (values) => ({
    n: values.length,
    p50: Math.round(pct(values, 50)),
    p95: Math.round(pct(values, 95)),
    min: Math.round(Math.min(...values)),
    max: Math.round(Math.max(...values))
});

// ── raw HTTP 分项 ──────────────────────────────────────────────────────────

/** 单次 GET（自动跟随最多 3 次重定向），返回各阶段毫秒数 */
function rawProbe(url, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        const started = process.hrtime.bigint();
        const ms = () => Number(process.hrtime.bigint() - started) / 1e6;
        const marks = { dns: 0, tcp: 0, tls: 0, ttfb: 0, body: 0 };
        const parsed = new URL(url);
        const client = parsed.protocol === 'https:' ? https : http;

        const req = client.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || undefined,
            path: `${parsed.pathname}${parsed.search}`,
            method: 'GET',
            headers: { 'User-Agent': 'bench', 'Accept-Encoding': 'gzip, deflate, br' },
            timeout: 20000
        });

        let dnsDone = false;
        let connectDone = false;
        let secureDone = false;

        req.on('socket', (socket) => {
            socket.once('lookup', () => { marks.dns = ms(); dnsDone = true; });
            socket.once('connect', () => { marks.tcp = ms(); connectDone = true; });
            socket.once('secureConnect', () => { marks.tls = ms(); secureDone = true; });
        });
        req.on('response', (res) => {
            marks.ttfb = ms();
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                res.resume();
                resolve(rawProbe(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
                return;
            }
            res.on('data', () => { });
            res.on('end', () => {
                marks.body = ms();
                resolve({
                    ...marks,
                    total: marks.body,
                    status: res.statusCode,
                    noDns: !dnsDone,
                    noConnect: !connectDone,
                    noTls: !secureDone
                });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

// ── 套件 ───────────────────────────────────────────────────────────────────

async function benchFetch() {
    const { fetchWebContent } = await import(toImportSpecifier(BUILD_ENTRY));
    const rows = [];

    for (const url of FETCH_URLS) {
        const appDurations = [];
        const rawTotals = [];
        let chars = 0;
        let appError = null;

        for (let i = 0; i < RUNS; i += 1) {
            try {
                const t0 = process.hrtime.bigint();
                const result = await fetchWebContent(url, 30000, { format: 'markdown', cache: 'reload' });
                appDurations.push(Number(process.hrtime.bigint() - t0) / 1e6);
                chars = result.content?.length ?? 0;
            } catch (error) {
                appError = error.message;
            }
            try {
                const probe = await rawProbe(url);
                rawTotals.push(probe.total);
            } catch {
                // 网络抖动时跳过该样本
            }
        }

        rows.push({
            url,
            chars,
            app: appDurations.length > 0 ? stats(appDurations) : null,
            raw: rawTotals.length > 0 ? stats(rawTotals) : null,
            overhead: appDurations.length > 0 && rawTotals.length > 0
                ? Math.round(pct(appDurations, 50) - pct(rawTotals, 50))
                : null,
            error: appError
        });
    }

    return rows;
}

async function benchSearch() {
    const { createMyWebSearchRuntime } = await import(toImportSpecifier(path.join(ROOT, 'build', 'runtime', 'createRuntime.js')));
    const runtime = createMyWebSearchRuntime();
    const rows = [];

    for (const query of SEARCH_QUERIES) {
        const durations = [];
        let count = 0;
        let error = null;
        for (let i = 0; i < RUNS; i += 1) {
            try {
                const t0 = process.hrtime.bigint();
                const result = await runtime.services.search.execute({
                    query,
                    engines: ['bing'],
                    limit: 5,
                    minResults: 0
                });
                durations.push(Number(process.hrtime.bigint() - t0) / 1e6);
                count = result.results?.length ?? 0;
            } catch (e) {
                error = e.message;
            }
        }
        rows.push({ query, engine: 'bing', results: count, ms: durations.length > 0 ? stats(durations) : null, error });
    }
    return rows;
}

// ── 输出 ───────────────────────────────────────────────────────────────────

const fmt = (s) => (s ? `p50=${s.p50} p95=${s.p95} (${s.min}–${s.max})` : '—');

async function main() {
    if (!existsSync(BUILD_ENTRY)) {
        console.error('❌ 找不到 build/，先跑：npm run build');
        process.exit(1);
    }

    const out = { runs: RUNS };
    if (ONLY === 'all' || ONLY === 'fetch') {
        out.fetch = await benchFetch();
    }
    if (ONLY === 'all' || ONLY === 'search') {
        out.search = await benchSearch();
    }

    if (JSON_OUT) {
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    console.log(`\n基准（每个样本 ${RUNS} 次）`);

    if (out.fetch) {
        console.log('\n抓取 fetchWebContent：');
        for (const row of out.fetch) {
            console.log(`  ${row.url}`);
            console.log(`    app  ${fmt(row.app)}  → ${row.chars} 字符`);
            console.log(`    raw  ${fmt(row.raw)}   (DNS/TCP/TLS/TTFB/body 单次 GET)`);
            console.log(`    应用层开销 ≈ ${row.overhead ?? '—'} ms${row.error ? `  ❌ ${row.error}` : ''}`);
        }
    }

    if (out.search) {
        console.log('\n搜索（单引擎 bing，排除多引擎并发）：');
        for (const row of out.search) {
            console.log(`  "${row.query}"  ${fmt(row.ms)}  → ${row.results} 条${row.error ? `  ❌ ${row.error}` : ''}`);
        }
    }
    console.log('');
}

main().catch((error) => {
    console.error(`❌ ${error?.stack ?? error}`);
    process.exit(1);
});
