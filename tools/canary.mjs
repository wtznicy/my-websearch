#!/usr/bin/env node
/**
 * 引擎 canary（P1-8 第一步）：固定查询集 × 全引擎，对比基线，骤降 >50% 时告警。
 *
 *   node tools/canary.mjs                       # 对比 .canary-baseline.json
 *   node tools/canary.mjs --update-baseline     # 写入当前结果为基线
 *   node tools/canary.mjs --engines bing,baidu  # 只测指定引擎
 *   node tools/canary.mjs --json
 *
 * 为什么需要它：免 API Key 的本质是解析上游页面，上游改版 = 静默失效（HTTP 200 + 0 条），
 * 而熔断器只认 429/202/bot_challenge，永远触发不了这种情况。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, '.canary-baseline.json');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const JSON_OUT = args.includes('--json');
const UPDATE = args.includes('--update-baseline');
const onlyEngines = flag('engines', '') ? flag('engines', '').split(',').map((e) => e.trim()) : null;

const QUERIES = ['typescript satisfies operator', 'python asyncio cancellation'];

const toSpec = (p) => pathToFileURL(path.join(ROOT, p)).href;
const { createMyWebSearchRuntime } = await import(toSpec('build/runtime/createRuntime.js'));
const { SUPPORTED_SEARCH_ENGINES } = await import(toSpec('build/engines/registry.js'));

const runtime = createMyWebSearchRuntime();
const engines = onlyEngines ?? SUPPORTED_SEARCH_ENGINES;
const counts = {};

for (const engine of engines) {
    let total = 0;
    for (const query of QUERIES) {
        try {
            const result = await runtime.services.search.execute({
                query,
                engines: [engine],
                limit: 5,
                minResults: 0,
                requestedEngines: [engine]
            });
            total += result.results.length;
        } catch {
            // 引擎异常按 0 条计
        }
    }
    counts[engine] = total;
}

const baseline = UPDATE || !fs.existsSync(BASELINE)
    ? null
    : JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

if (UPDATE) {
    fs.writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`, 'utf8');
}

const rows = engines.map((engine) => {
    const now = counts[engine] ?? 0;
    const before = baseline?.[engine];
    const drop = typeof before === 'number' && before > 0 ? now / before : null;
    return { engine, now, baseline: before ?? null, drop, alert: drop !== null && drop < 0.5 };
});

if (JSON_OUT) {
    console.log(JSON.stringify({ counts, rows, updated: UPDATE }, null, 2));
} else {
    console.log(`canary: ${engines.length} engines × ${QUERIES.length} queries`);
    for (const row of rows) {
        const base = row.baseline === null ? '—' : String(row.baseline);
        const ratio = row.drop === null ? '—' : `${Math.round(row.drop * 100)}%`;
        const mark = row.alert ? '⚠️ DROP' : '';
        console.log(`  ${row.engine.padEnd(14)} now=${String(row.now).padStart(2)}  baseline=${base.padStart(2)}  ratio=${ratio.padStart(4)}  ${mark}`);
    }
    if (UPDATE) {
        console.log(`\n✅ baseline written to ${path.basename(BASELINE)}`);
    }
}

if (rows.some((row) => row.alert)) {
    console.error('\n⚠️ 至少一个引擎相对基线骤降 >50%，上游页面结构可能已改版');
    process.exitCode = 1;
}
