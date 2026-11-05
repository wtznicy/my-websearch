// tools/eval-search-quality.mjs
// 评测搜索质量与稳定性的基准脚本
// 覆盖 10 个固定典型场景，每个用例运行 3 遍，记录延迟中位数、域名多样性、官方域命中数、噪声比例及引擎波动。
// 用法: node tools/eval-search-quality.mjs [--quick] [filter]

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createMyWebSearchRuntime } = await import('../build/runtime/createRuntime.js');
const { pickDefaultEnginesForQuery } = await import('../build/core/search/queryEngineRouting.js');

const rawArgs = process.argv.slice(2);
const isQuick = rawArgs.includes('--quick');
const filter = rawArgs.find((a) => !a.startsWith('--')) || '';
const RUN_ROUNDS = isQuick ? 1 : 3;

export const BENCHMARK_CASES = [
    {
        id: 'vitest-node22',
        name: 'Vitest 5 Node.js 22 configuration',
        query: 'Vitest 5 Node.js 22 configuration',
        category: '英文技术配置',
        limit: 6,
        officialDomains: ['vitest.dev', 'nodejs.org', 'github.com'],
        noiseRegex: /bluetooth|audio|headphone|dongle|蓝牙/i
    },
    {
        id: 'mcp-spec',
        name: 'MCP specification',
        query: 'MCP specification',
        category: '英文官方规范',
        limit: 6,
        officialDomains: ['modelcontextprotocol.io', 'github.com'],
        noiseRegex: /minecraft|master.*chief|combat/i
    },
    {
        id: 'vitest-zh',
        name: 'Vitest 中文文档',
        query: 'Vitest 中文文档',
        category: '中文技术搜索',
        limit: 6,
        officialDomains: ['vitest.dev', 'github.com'],
        noiseRegex: /ping|测速|React 18.*Electron|pytest.*文档/i
    },
    {
        id: 'mcp-zh-official',
        name: 'MCP 协议 官方文档',
        query: 'MCP 协议 官方文档',
        category: '中文权威多样性',
        limit: 6,
        officialDomains: ['modelcontextprotocol.io', 'github.com'],
        noiseRegex: /chatgpt.*镜像|openai.*账号购买/i
    },
    {
        id: 'nodejs-lts',
        name: 'Node.js 最新 LTS 版本',
        query: 'Node.js 最新 LTS 版本',
        category: '时效性版本检索',
        limit: 6,
        officialDomains: ['nodejs.org'],
        noiseRegex: /letpub|sci期刊|影响因子|download\.csdn\.net/i
    },
    {
        id: 'nextjs-15',
        name: 'Next.js 15 breaking changes',
        query: 'Next.js 15 breaking changes',
        category: '前沿版本发布',
        limit: 6,
        officialDomains: ['nextjs.org', 'github.com', 'vercel.com'],
        noiseRegex: /培训|包过|低价买课/i
    },
    {
        id: 'docker-error',
        name: 'Docker 无法拉取镜像 connection refused',
        query: 'Docker 无法拉取镜像 connection refused',
        category: '中文实战排障',
        limit: 6,
        officialDomains: ['docker.com'],
        noiseRegex: /游戏私服|传奇挂机/i
    },
    {
        id: 'zustand-redux',
        name: 'Zustand vs Redux Toolkit 状态管理对比',
        query: 'Zustand vs Redux Toolkit 状态管理对比',
        category: '中文技术对比',
        limit: 6,
        officialDomains: ['pmnd.rs', 'redux-toolkit.js.org'],
        noiseRegex: /低价代写|论文辅导/i
    },
    {
        id: 'postgresql-home',
        name: 'PostgreSQL 官网',
        query: 'PostgreSQL 官网',
        category: '导航官网查询',
        limit: 6,
        officialDomains: ['postgresql.org'],
        noiseRegex: /破解版|绿色安装包|天空下载|华军软件/i
    },
    {
        id: 'oauth21-flow',
        name: 'OAuth 2.1 RFC authorization code flow',
        query: 'OAuth 2.1 RFC authorization code flow',
        category: '英文协议规范',
        limit: 6,
        officialDomains: ['ietf.org', 'datatracker.ietf.org'],
        noiseRegex: /free.*download.*crack/i
    }
];

function extractDomain(url) {
    try {
        const u = new URL(url);
        return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return url;
    }
}

function matchesAny(urlOrHost, domains) {
    const norm = urlOrHost.toLowerCase();
    return domains.some((d) => norm === d || norm.endsWith(`.${d}`) || norm.includes(d));
}

function computeMedian(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function computePercentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
}

async function runEvaluation() {
    console.log(`\n======================================================`);
    console.log(`🔍 my-websearch 搜索质量基准评测`);
    console.log(`运行轮数: ${RUN_ROUNDS} 轮 (取中位数)`);
    console.log(`======================================================\n`);

    const runtime = createMyWebSearchRuntime();
    const casesToRun = BENCHMARK_CASES.filter((c) =>
        !filter || c.id.toLowerCase().includes(filter.toLowerCase()) || c.name.toLowerCase().includes(filter.toLowerCase())
    );

    const summaries = [];
    const allDurations = [];

    for (let cIdx = 0; cIdx < casesToRun.length; cIdx += 1) {
        const testCase = casesToRun[cIdx];
        process.stdout.write(`[${cIdx + 1}/${casesToRun.length}] 正在评测: ${testCase.category} - "${testCase.query}" ... `);

        const roundDurations = [];
        const roundResults = [];

        // 预解析引擎列表（与 MCP/CLI 一致）
        const routedEngines = pickDefaultEnginesForQuery(testCase.query, runtime.config.defaultSearchEngine, {
            en: runtime.config.autoRouteEnEngines,
            zh: runtime.config.autoRouteZhEngines
        });

        for (let r = 0; r < RUN_ROUNDS; r += 1) {
            // 清理缓存以保证测得真实网络性能与稳定性
            runtime.services.search.clearCache();
            const start = Date.now();
            let execution;
            try {
                execution = await runtime.services.search.execute({
                    query: testCase.query,
                    limit: testCase.limit,
                    engines: routedEngines,
                    requestedEngines: routedEngines
                });
            } catch (err) {
                execution = {
                    results: [],
                    outcome: 'error',
                    warnings: [err.message]
                };
            }
            const duration = Date.now() - start;
            roundDurations.push(duration);
            allDurations.push(duration);
            roundResults.push(execution);
        }

        const medianDuration = computeMedian(roundDurations);
        process.stdout.write(`完成 (耗时: ${roundDurations.join('ms, ')}ms -> 中位数 ${medianDuration}ms)\n`);

        // 取耗时中位数对应的那一轮结果作为展示代表
        const sampleResult = roundResults[Math.floor(roundResults.length / 2)];
        const items = sampleResult.results || [];

        const domains = items.map((it) => extractDomain(it.url));
        const uniqueDomains = [...new Set(domains)];
        const officialHits = items.filter((it) => matchesAny(it.url, testCase.officialDomains)).length;
        const noiseHits = items.filter((it) => testCase.noiseRegex.test(`${it.title} ${it.description}`)).length;

        const top1 = items[0];
        const top1Domain = top1 ? extractDomain(top1.url) : 'none';
        const top1IsOfficial = top1 ? matchesAny(top1.url, testCase.officialDomains) : false;

        // 稳定性判断：3 轮的 Top1 URL 是否完全一致
        const top1Urls = roundResults.map((r) => r.results?.[0]?.url || 'none');
        const isStableTop1 = top1Urls.every((u) => u === top1Urls[0]);

        const cascaded = sampleResult.cascadedEngines || [];

        summaries.push({
            id: testCase.id,
            category: testCase.category,
            query: testCase.query,
            medianMs: medianDuration,
            allMs: roundDurations,
            totalItems: items.length,
            uniqueDomainsCount: uniqueDomains.length,
            domains: uniqueDomains.slice(0, 4).join(', '),
            officialHits,
            noiseHits,
            top1Title: top1 ? top1.title.slice(0, 36) : '无结果',
            top1Domain,
            top1IsOfficial,
            isStableTop1,
            top1Urls,
            enginesUsed: routedEngines.join('+'),
            cascaded: cascaded.length > 0 ? cascaded.join(',') : '无',
            outcome: sampleResult.outcome
        });
    }

    // 输出结构化汇总表格
    console.log(`\n======================================================`);
    console.log(`📊 评测汇总表 (${casesToRun.length} 个场景)`);
    console.log(`======================================================`);

    console.table(
        summaries.map((s) => ({
            '分类': s.category,
            '查询词': s.query.length > 18 ? s.query.slice(0, 16) + '..' : s.query,
            'P50耗时(ms)': s.medianMs,
            '域名数': `${s.uniqueDomainsCount}/${s.totalItems}`,
            '官方命中': s.officialHits,
            '噪声数': s.noiseHits,
            'Top1官方': s.top1IsOfficial ? '✅ 是' : '❌ 否',
            'Top1域名': s.top1Domain,
            'Top1标题': s.top1Title,
            '3轮稳定性': s.isStableTop1 ? '✅ 稳定' : '⚠️ 波动',
            '级联引擎': s.cascaded
        }))
    );

    const overallP50 = computePercentile(allDurations, 50);
    const overallP95 = computePercentile(allDurations, 95);
    const totalOfficialHits = summaries.reduce((acc, s) => acc + s.officialHits, 0);
    const totalNoiseHits = summaries.reduce((acc, s) => acc + s.noiseHits, 0);
    const stableTop1Ratio = (summaries.filter((s) => s.isStableTop1).length / summaries.length) * 100;
    const top1OfficialRatio = (summaries.filter((s) => s.top1IsOfficial).length / summaries.length) * 100;

    console.log(`\n------------------------------------------------------`);
    console.log(`📈 全局宏观指标:`);
    console.log(`- 总体 P50 墙钟耗时: ${overallP50} ms`);
    console.log(`- 总体 P95 墙钟耗时: ${overallP95} ms`);
    console.log(`- 官方/权威域命中总数: ${totalOfficialHits} 条`);
    console.log(`- 显式噪音拦截剩余数: ${totalNoiseHits} 条`);
    console.log(`- Top1 官方/权威命中率: ${top1OfficialRatio.toFixed(1)}%`);
    console.log(`- 3轮 Top1 结果稳定性: ${stableTop1Ratio.toFixed(1)}%`);
    console.log(`------------------------------------------------------\n`);

    // 重点分析不稳定案例的波动来源
    const unstableCases = summaries.filter((s) => !s.isStableTop1);
    if (unstableCases.length > 0) {
        console.log(`⚠️ 波动场景 Top1 详细对比:`);
        for (const u of unstableCases) {
            console.log(`- [${u.category}] ${u.query}:`);
            u.top1Urls.forEach((url, i) => console.log(`  第 ${i + 1} 轮: ${url}`));
        }
        console.log(`\n`);
    }
}

runEvaluation().catch((err) => {
    console.error('评测执行出错:', err);
    process.exit(1);
});
