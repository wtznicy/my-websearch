#!/usr/bin/env node
/**
 * Brave 429 冷却窗口计时器。
 *
 * 目的：测量「HTTP 打到 429 之后，多久才能恢复」，用于校准熔断器的首档冷却。
 *
 * 关键实现细节：
 * - 每次探测都走**真实 CLI**（node build/index.js search --engine brave），
 *   与线上路径（curl + 系统代理 + 引擎熔断/缓存）一致，而不是裸 curl 猜测。
 * - 探测时强制 `BRAVE_BROWSER_FALLBACK=0`：否则 429 会被无头浏览器兜底掩盖，
 *   我们就测不到 429 窗口本身。
 * - 每次探测用唯一 query + 独立进程：进程内 TTL 缓存与熔断状态不会干扰测量。
 * - 瞬时 TLS 失败（curl 35）会重试，归类为 transient，不算 429 也不算成功。
 *
 * 用法：
 *   node tools/brave-cooldown-probe.mjs probe [--retries 3]
 *   node tools/brave-cooldown-probe.mjs settle [--step 30] [--max 900]
 *   node tools/brave-cooldown-probe.mjs burn [--max 30]
 *   node tools/brave-cooldown-probe.mjs blind [--wait 180] [--max 900] [--burn-first]
 *   node tools/brave-cooldown-probe.mjs find-min [--step 30] [--max 600] [--trials 3]
 *                                        [--reset-wait 90] [--extra 10] [--burn-max 30]
 *
 * 测量方法（重要）：
 * - **blind** 是唯一无偏的恢复时间测法：等待期间不发请求，到点只探一次。
 *   每 30s 探一次会持续「喂」限流，实测能把 3 分钟的窗口拖到 7 分钟以上。
 * - `find-min --extra N` 会先打到 429，再额外打 N 次（加深惩罚），然后从最后一次请求开始计时。
 * - 两次试验之间用 `--reset-wait` 盲等恢复，避免探测干扰下一次。
 *
 * 输出：每行一条 JSON（便于后处理），最后一条 `{"event":"summary",...}`。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'build', 'index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
    const options = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            options._.push(token);
            continue;
        }
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            options[key] = true;
        } else {
            options[key] = next;
            i += 1;
        }
    }
    return options;
}

function log(payload) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...payload }));
}

let probeSeq = 0;

async function probeOnce() {
    probeSeq += 1;
    const query = `cooldown-probe-${Date.now()}-${probeSeq}`;
    const startedAt = Date.now();
    let stdout = '';
    try {
        const result = await execFileAsync(
            process.execPath,
            [CLI, 'search', query, '--engine', 'brave', '--limit', '3', '--min-results', '0', '--json'],
            {
                cwd: ROOT,
                timeout: 60_000,
                maxBuffer: 4 * 1024 * 1024,
                env: {
                    ...process.env,
                    BRAVE_BROWSER_FALLBACK: '0',
                    LOG_LEVEL: 'quiet'
                }
            }
        );
        stdout = result.stdout;
    } catch (error) {
        // CLI 在搜索失败时以非 0 退出，但 JSON envelope 仍写在 stdout
        stdout = error?.stdout ?? '';
    }
    const latencyMs = Date.now() - startedAt;
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return { status: 'transient', latencyMs, detail: 'unparsable CLI output' };
    }
    const data = parsed?.data ?? {};
    const failure = Array.isArray(data.partialFailures) ? data.partialFailures[0] : undefined;
    const message = String(failure?.message ?? parsed?.error?.message ?? '');
    const resultCount = Number(data.totalResults ?? 0);
    if (resultCount > 0) {
        return { status: 'ok', latencyMs, results: resultCount };
    }
    if (/429|rate limit|bot_challenge|anti-bot|captcha|human verification/i.test(message)) {
        return { status: 'blocked', latencyMs, detail: message.slice(0, 160) };
    }
    if (/curl:|TLS|ECONN|socket|timeout|ENOTFOUND/i.test(message)) {
        return { status: 'transient', latencyMs, detail: message.slice(0, 160) };
    }
    return { status: 'unknown', latencyMs, detail: message.slice(0, 160) };
}

async function probeWithRetry(retries = 3, backoffMs = 2000) {
    let last;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        last = await probeOnce();
        if (last.status !== 'transient') {
            return last;
        }
        if (attempt < retries) {
            await sleep(backoffMs * attempt);
        }
    }
    return last;
}

async function waitSeconds(seconds, label) {
    const startedAt = Date.now();
    log({ event: 'wait_start', label, seconds });
    await sleep(seconds * 1000);
    log({ event: 'wait_end', label, elapsedMs: Date.now() - startedAt });
}

async function settle(stepSeconds, maxSeconds) {
    const startedAt = Date.now();
    for (let waited = 0; waited <= maxSeconds; waited += stepSeconds) {
        if (waited > 0) {
            await waitSeconds(stepSeconds, 'settle');
        }
        const probe = await probeWithRetry();
        log({ event: 'settle_probe', waited, ...probe });
        if (probe.status === 'ok') {
            return { recovered: true, elapsedMs: Date.now() - startedAt };
        }
    }
    return { recovered: false, elapsedMs: Date.now() - startedAt };
}

async function burn(maxRequests = 30) {
    const startedAt = Date.now();
    for (let i = 1; i <= maxRequests; i += 1) {
        const probe = await probeWithRetry();
        log({ event: 'burn_probe', attempt: i, ...probe });
        if (probe.status === 'blocked') {
            return { blocked: true, requests: i, blockedAt: Date.now() };
        }
        if (probe.status === 'ok') {
            continue;
        }
    }
    return { blocked: false, requests: maxRequests, blockedAt: Date.now() };
}

/**
 * 盲等模式：等待期间**不发任何请求**，到点只探一次。
 * 这是测量「恢复时间」的唯一不含偏差的方法——每 30s 探一次会持续喂限流，
 * 实测会把 3 分钟的窗口拖成 7 分钟以上。
 */
async function blind(waitStepSeconds, maxSeconds, burnFirst) {
    if (burnFirst) {
        const burnResult = await burn();
        if (!burnResult.blocked) {
            log({ event: 'summary', phase: 'blind', error: 'never hit 429 during burn' });
            return;
        }
        log({ event: 'blind_start', blockedAt: burnResult.blockedAt });
    }
    const startedAt = Date.now();
    for (let waited = waitStepSeconds; waited <= maxSeconds; waited += waitStepSeconds) {
        await waitSeconds(waitStepSeconds, 'blind');
        const probe = await probeWithRetry();
        log({ event: 'blind_probe', waited, elapsedMs: Date.now() - startedAt, ...probe });
        if (probe.status === 'ok') {
            log({ event: 'summary', phase: 'blind', recoveredAfterMs: Date.now() - startedAt, waitSeconds: waitStepSeconds });
            return;
        }
    }
    log({ event: 'summary', phase: 'blind', recoveredAfterMs: null, maxSeconds });
}

/**
 * 定速模式：按固定间隔发请求，用来区分「每分钟 N 次」还是「短窗口突发」。
 * 间隔按「请求开始时间」对齐（t_i = start + i * interval），不受单次探测耗时影响。
 */
async function rateTest(intervalSeconds, count) {
    log({ event: 'phase', name: 'rate', intervalSeconds, count });
    const startedAt = Date.now();
    for (let i = 1; i <= count; i += 1) {
        const target = startedAt + (i - 1) * intervalSeconds * 1000;
        const wait = target - Date.now();
        if (wait > 0) {
            await sleep(wait);
        }
        const probe = await probeWithRetry(1);
        log({ event: 'rate_probe', index: i, intervalSeconds, elapsedMs: Date.now() - startedAt, ...probe });
        if (probe.status === 'blocked') {
            log({ event: 'summary', phase: 'rate', blockedAtRequest: i, intervalSeconds, elapsedMs: Date.now() - startedAt });
            return;
        }
    }
    log({ event: 'summary', phase: 'rate', blockedAtRequest: null, intervalSeconds, requests: count });
}

async function findSafe(stepSeconds, maxSeconds) {
    log({ event: 'phase', name: 'find-safe', stepSeconds, maxSeconds });
    const settled = await settle(30, Math.max(stepSeconds * 3, 300));
    if (!settled.recovered) {
        log({ event: 'summary', phase: 'find-safe', error: 'could not reach a recovered state before trial' });
        return;
    }
    const burnResult = await burn();
    if (!burnResult.blocked) {
        log({ event: 'summary', phase: 'find-safe', error: 'never hit 429 during burn' });
        return;
    }
    const t0 = burnResult.blockedAt;
    for (let waited = stepSeconds; waited <= maxSeconds; waited += stepSeconds) {
        await waitSeconds(stepSeconds, 'find-safe');
        const probe = await probeWithRetry();
        log({ event: 'safe_probe', waited, elapsedMs: Date.now() - t0, ...probe });
        if (probe.status === 'ok') {
            log({ event: 'summary', phase: 'find-safe', safeUpperBoundMs: Date.now() - t0, stepSeconds });
            return;
        }
    }
    log({ event: 'summary', phase: 'find-safe', safeUpperBoundMs: null, maxSeconds });
}

async function findMin(stepSeconds, maxSeconds, trials, resetWaitSeconds, extraRequests, burnMax) {
    log({ event: 'phase', name: 'find-min', stepSeconds, maxSeconds, trials, resetWaitSeconds, extraRequests });
    const observations = [];
    for (let trial = 1; trial <= trials; trial += 1) {
        // 两次试验之间：优先用「盲等」恢复（不发请求，避免探测本身延长窗口）；
        // 未指定时退回探测式 settle。
        if (resetWaitSeconds > 0) {
            await waitSeconds(resetWaitSeconds, `reset-t${trial}`);
        } else {
            const settled = await settle(30, Math.max(stepSeconds * 3, 300));
            if (!settled.recovered) {
                log({ event: 'trial_abort', trial, reason: 'not recovered before burn' });
                continue;
            }
        }
        const burnResult = await burn(burnMax);
        if (!burnResult.blocked) {
            log({ event: 'trial_abort', trial, reason: 'never hit 429 during burn' });
            continue;
        }
        // 可选：429 之后继续多打 N 次，模拟「重罚」场景；计时从最后一次请求开始。
        for (let extra = 1; extra <= extraRequests; extra += 1) {
            const probe = await probeWithRetry(1);
            log({ event: 'extra_probe', trial, extra, ...probe });
        }
        const t0 = Date.now();
        let recoveredAtMs = null;
        for (let waited = stepSeconds; waited <= maxSeconds; waited += stepSeconds) {
            await waitSeconds(stepSeconds, `find-min-t${trial}`);
            const probe = await probeWithRetry();
            log({ event: 'min_probe', trial, waited, elapsedMs: Date.now() - t0, ...probe });
            if (probe.status === 'ok') {
                recoveredAtMs = Date.now() - t0;
                break;
            }
        }
        observations.push(recoveredAtMs);
        log({ event: 'trial_result', trial, recoveredAtMs });
    }
    const valid = observations.filter((value) => typeof value === 'number');
    valid.sort((a, b) => a - b);
    log({
        event: 'summary',
        phase: 'find-min',
        trials,
        observationsMs: observations,
        minMs: valid[0] ?? null,
        medianMs: valid.length > 0 ? valid[Math.floor(valid.length / 2)] : null,
        stepSeconds
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const command = options._[0] ?? 'probe';
    const stepSeconds = Number(options.step ?? 60);
    const maxSeconds = Number(options.max ?? 900);
    const trials = Number(options.trials ?? 3);

    switch (command) {
        case 'probe': {
            const probe = await probeWithRetry(Number(options.retries ?? 3));
            log({ event: 'probe', ...probe });
            return;
        }
        case 'settle': {
            const result = await settle(stepSeconds, maxSeconds);
            log({ event: 'summary', phase: 'settle', ...result });
            return;
        }
        case 'burn': {
            const result = await burn(Number(options.max ?? 30));
            log({ event: 'summary', phase: 'burn', ...result });
            return;
        }
        case 'find-safe':
            await findSafe(stepSeconds, maxSeconds);
            return;
        case 'blind':
            await blind(
                Number(options.wait ?? options.step ?? 60),
                maxSeconds,
                Boolean(options['burn-first'])
            );
            return;
        case 'rate':
            await rateTest(Number(options.interval ?? 10), Number(options.count ?? 8));
            return;
        case 'find-min':
            await findMin(
                stepSeconds,
                maxSeconds,
                trials,
                Number(options['reset-wait'] ?? 0),
                Number(options.extra ?? 0),
                Number(options['burn-max'] ?? 30)
            );
            return;
        default:
            console.error(`Unknown command: ${command}`);
            process.exitCode = 1;
    }
}

main().catch((error) => {
    log({ event: 'fatal', message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
});
