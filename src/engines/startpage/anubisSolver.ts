import * as crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { config, engineShouldUseProxy } from '../../config.js';
import { buildAxiosRequestOptions, isNetworkLayerError, requestDirectFirst, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { getSystemProxyFallbackUrl } from '../../utils/systemProxy.js';

/**
 * Startpage Anubis 反爬的纯 Node 求解器（无浏览器）。
 *
 * 背景：Startpage 自 2025 年起部署 Anubis WAF（Proof-of-Work 挑战）——纯 HTTP 请求
 * 拿到的是 `<script id="anubis_challenge">` 挑战页（"Verifying your request..."），
 * 之前的方案是启动 Playwright（hidden-headed）跑通挑战，代价约 10s + 400MB 内存。
 *
 * Anubis 的 PoW 本质是 `SHA256(randomData + nonce)` 前缀满足 difficulty 个 0——
 * 在 Node 原生 crypto 里（difficulty=4~5）只需百毫秒到 1 秒级，因此可以：
 *   1. GET 首页 → 解析挑战 payload 与 Set-Cookie（spchal-cookie-verification）
 *   2. Worker 线程异步 PoW 求解（不阻塞主事件循环，支持 AbortSignal 立即终止）
 *   3. GET pass-challenge（带 cookie）→ 302 + spchal-auth（JWT，有效期 5 分钟）
 *   4. 带全部 cookie 再取首页 → 搜索表单的 sc token
 *
 * 当 difficulty >= 6 时，单核期望迭代 16^6 ≈ 1677 万次（约 16s，远超单引擎 10s 预算），
 * 此时直接放弃纯 HTTP PoW（返回 null），避免无意义耗尽 CPU 与阻塞超时。
 */

const STARTPAGE_BASE_URL = 'https://www.startpage.com';
const ANUBIS_PASS_PATH = '/.within.website/x/cmd/anubis/api/pass-challenge';
/** PoW 迭代上限（difficulty 正常为 4~5；被标记 IP 升至 6+ 时直接跳过） */
const POW_MAX_NONCE = 48_000_000;
/**
 * 默认内联求解的最大 difficulty。
 * difficulty=6 期望约 16.7M 次哈希；单核约 16s，多 Worker 分片后约 4–6s，
 * 因此默认放宽到 6（>=7 的期望成本仍在数十秒级，继续跳过）。
 */
export const ANUBIS_DEFAULT_MAX_POW_DIFFICULTY = 6;

export function getMaxAnubisPowDifficulty(): number {
    const raw = process.env.ANUBIS_MAX_POW_DIFFICULTY?.trim();
    if (raw) {
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 8) {
            return parsed;
        }
    }
    return ANUBIS_DEFAULT_MAX_POW_DIFFICULTY;
}

import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';
const BROWSER_UA = DEFAULT_DESKTOP_UA;

export type AnubisSession = {
    /** 放行后的完整 Cookie 串（spchal-cookie-verification + spchal-auth 等） */
    cookies: string;
    /** 搜索表单的 sc token */
    scCode: string;
};

/** 同步求解 Anubis PoW（保留供低难度单测调用）：找 nonce 使 sha256(randomData + nonce) 以 difficulty 个 '0' 开头 */
export function solveAnubisPow(randomData: string, difficulty: number): { nonce: number; hash: string } | null {
    const prefix = '0'.repeat(Math.max(1, Math.min(Math.floor(difficulty) || 1, 8)));
    for (let nonce = 0; nonce < POW_MAX_NONCE; nonce += 1) {
        const hash = crypto.createHash('sha256').update(`${randomData}${nonce}`).digest('hex');
        if (hash.startsWith(prefix)) {
            return { nonce, hash };
        }
    }
    return null;
}

const ANUBIS_POW_WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const { randomData, difficulty, maxNonce, start = 0, stride = 1 } = workerData;
const prefix = '0'.repeat(Math.max(1, Math.min(Math.floor(difficulty) || 1, 8)));
let found = null;
for (let nonce = start; nonce < maxNonce; nonce += stride) {
    const hash = crypto.createHash('sha256').update(randomData + nonce).digest('hex');
    if (hash.startsWith(prefix)) {
        found = { nonce, hash };
        break;
    }
}
parentPort.postMessage(found);
`;

/**
 * 在独立 Worker 线程中异步求解 Anubis PoW：
 * - 绝不阻塞主线程事件循环（并发的掘金/百度等请求不受影响）
 * - 响应 AbortSignal：超时或取消时立即 terminate() 工作线程，不在后台空转烧 CPU
 */
export function solveAnubisPowAsync(
    randomData: string,
    difficulty: number,
    signal?: AbortSignal
): Promise<{ nonce: number; hash: string } | null> {
    if (signal?.aborted) {
        return Promise.resolve(null);
    }

    // difficulty 6 期望 16.7M 次哈希；单核约 16s（超出单引擎预算）。
    // 把 nonce 空间按 stride 分给多个 Worker，4 核约 4–6s 即可完成。
    const workerCount = Math.max(1, Math.min(4, cpus().length));

    return new Promise((resolve) => {
        let settled = false;
        let expected = 0;
        let completed = 0;
        const workers: Worker[] = [];

        const terminateAll = () => {
            for (const worker of workers) {
                void worker.terminate().catch(() => undefined);
            }
        };
        const finish = (result: { nonce: number; hash: string } | null) => {
            if (settled) {
                return;
            }
            settled = true;
            if (signal && onAbort) {
                signal.removeEventListener('abort', onAbort);
            }
            terminateAll();
            resolve(result);
        };
        const onAbort = () => finish(null);

        try {
            for (let index = 0; index < workerCount; index += 1) {
                const worker = new Worker(ANUBIS_POW_WORKER_SCRIPT, {
                    eval: true,
                    workerData: {
                        randomData,
                        difficulty,
                        maxNonce: POW_MAX_NONCE,
                        start: index,
                        stride: workerCount
                    }
                });
                workers.push(worker);
                expected += 1;
                let workerDone = false;
                const noteDone = () => {
                    if (workerDone || settled) {
                        return;
                    }
                    workerDone = true;
                    completed += 1;
                    if (completed >= expected) {
                        finish(null);
                    }
                };
                worker.once('message', (msg: { nonce: number; hash: string } | null) => {
                    if (msg) {
                        finish(msg);
                    } else {
                        noteDone();
                    }
                });
                worker.once('error', noteDone);
                worker.once('exit', noteDone);
            }
        } catch {
            // 极端受限环境无法创建 Worker 时回退同步求解（仅在 <= maxDifficulty 时调用）
            terminateAll();
            if (workers.length === 0) {
                finish(solveAnubisPow(randomData, difficulty));
                return;
            }
        }

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

/** 从挑战页 HTML 解析 Anubis payload（challenge.id / randomData / rules.difficulty） */
export function parseAnubisChallenge(html: string): { id: string; randomData: string; difficulty: number } | null {
    const match = html.match(/id="anubis_challenge"[^>]*>([\s\S]*?)<\/script>/);
    const jsonText = match?.[1]?.trim();
    if (!jsonText) {
        return null;
    }
    try {
        const payload = JSON.parse(jsonText) as {
            rules?: { difficulty?: number };
            challenge?: { id?: string; randomData?: string };
        };
        const id = payload.challenge?.id;
        const difficulty = payload.rules?.difficulty;
        if (typeof id !== 'string' || typeof difficulty !== 'number') {
            return null;
        }
        // randomData 是 PoW 输入；缺失时退回 id（早期版本行为）
        return { id, randomData: String(payload.challenge?.randomData ?? id), difficulty };
    } catch {
        return null;
    }
}

/** 从首页 HTML 提取搜索表单的 sc token */
export function extractStartpageScToken(html: string): string | undefined {
    const match = html.match(/name="sc"[^>]*value="([^"]+)"/)
        || html.match(/value="([^"]+)"[^>]*name="sc"/);
    return match?.[1]?.trim() || undefined;
}

function collectSetCookies(response: { headers?: Record<string, unknown> }): string[] {
    const raw = response.headers?.['set-cookie'];
    const values = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
    return values.map((value) => String(value).split(';')[0] ?? '').filter(Boolean);
}

function mergeCookiePairs(...groups: string[][]): string {
    const jar = new Map<string, string>();
    for (const group of groups) {
        for (const pair of group) {
            const name = pair.split('=', 1)[0];
            if (name) {
                jar.set(name, pair);
            }
        }
    }
    return [...jar.values()].join('; ');
}

/**
 * P0-4：startpage 已在 PROXY_ENGINES（或有系统代理兜底）时，直接走代理发起请求，
 * 避免 requestDirectFirst 对每一步都先直连挂满 15s 超时（3 步 × 15s = 45s 必超单引擎预算）。
 */
async function requestStartpageAnubisStep(
    url: string,
    buildOptions: (forceDirect: boolean) => AxiosRequestConfig,
    label: string
): Promise<AxiosResponse> {
    const shouldUseProxy = (config.useProxy && Boolean(config.proxyUrl) && engineShouldUseProxy('startpage'))
        || Boolean(getSystemProxyFallbackUrl('startpage'));
    const call = (useProxy: boolean): Promise<AxiosResponse> => useProxy
        ? requestWithSafeRedirects('GET', url, buildOptions(false), label)
        : requestDirectFirst('GET', url, buildOptions, label);

    const isRetryable = (error: unknown): boolean => {
        const message = error instanceof Error ? error.message : String(error);
        const status = (error as { response?: { status?: number } })?.response?.status;
        // socket hang up / 超时 + Anubis 偶发 5xx，都值得在同一步重试；
        // 5xx 往往是上游瞬态（挑战已算完却提交失败），不应让整条 PoW 白算。
        return isNetworkLayerError(message) || (typeof status === 'number' && status >= 500);
    };

    try {
        return await call(shouldUseProxy);
    } catch (error) {
        if (!isRetryable(error)) {
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
            return await call(shouldUseProxy);
        } catch (retryError) {
            if (!shouldUseProxy || !isRetryable(retryError)) {
                throw retryError;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
            return await call(false);
        }
    }
}

let inflightAnubisWarmup: Promise<AnubisSession | null> | null = null;

async function runAnubisPowWarmup(signal?: AbortSignal): Promise<AnubisSession | null> {
    const startedAt = Date.now();
    const requestOptions = (forceDirect: boolean): AxiosRequestConfig => buildAxiosRequestOptions({
        engine: 'startpage',
        // 不用 trustedStaticHost：它强制禁用重定向，而 Anubis 流程本身依赖 302
        // （首页可能重定向、pass-challenge 的放行凭证就在 302 响应上）
        forceDirect,
        signal,
        headers: {
            'User-Agent': BROWSER_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 8000,
        validateStatus: (status: number) => status >= 200 && status < 400
    });

    // 1) 首页 → 挑战 payload + cookie
    const home = await requestStartpageAnubisStep(`${STARTPAGE_BASE_URL}/`, requestOptions, 'Startpage Anubis');
    const homeHtml = String(home.data || '');
    const initialCookies = collectSetCookies(home);

    // 已被放行（无挑战）时直接提取 sc
    const directSc = extractStartpageScToken(homeHtml);
    if (directSc) {
        return { cookies: initialCookies.join('; '), scCode: directSc };
    }

    const challenge = parseAnubisChallenge(homeHtml);
    if (!challenge) {
        // "Startpage Blocked" 等硬封禁页没有挑战 payload —— 交给 Playwright 兜底或上层报错
        return null;
    }

    const maxDifficulty = getMaxAnubisPowDifficulty();
    if (challenge.difficulty > maxDifficulty) {
        console.warn(
            `Startpage Anubis PoW difficulty ${challenge.difficulty} exceeds max inline threshold (${maxDifficulty}); skipping PoW to avoid blocking/timeout`
        );
        return null;
    }

    // 2) Worker 线程异步 PoW（支持 signal 立即终止）
    const solved = await solveAnubisPowAsync(challenge.randomData, challenge.difficulty, signal);
    if (!solved) {
        if (!signal?.aborted) {
            console.warn(`Startpage Anubis PoW failed or exceeded ${POW_MAX_NONCE} iterations (difficulty ${challenge.difficulty})`);
        }
        return null;
    }

    // 3) 提交解答 → 302 + spchal-auth
    const passUrl = `${STARTPAGE_BASE_URL}${ANUBIS_PASS_PATH}`
        + `?id=${encodeURIComponent(challenge.id)}`
        + `&response=${solved.hash}`
        + `&nonce=${solved.nonce}`
        + `&redir=${encodeURIComponent(`${STARTPAGE_BASE_URL}/`)}`
        + `&elapsedTime=${Date.now() - startedAt}`;
    const pass = await requestStartpageAnubisStep(passUrl, (forceDirect) => ({
        ...requestOptions(forceDirect),
        // 302 响应上带 spchal-auth（跟随会丢失）——在此中断以读取 Set-Cookie
        stopOnRedirect: true,
        headers: {
            ...requestOptions(forceDirect).headers,
            'Cookie': initialCookies.join('; ')
        }
    }), 'Startpage Anubis pass');
    const authCookies = collectSetCookies(pass);
    if (pass.status !== 302 && pass.status !== 200) {
        console.warn(`Startpage Anubis pass-challenge returned HTTP ${pass.status}`);
        return null;
    }

    // 4) 带全部 cookie 取首页 → sc token
    const allCookies = mergeCookiePairs(initialCookies, authCookies);
    const home2 = await requestStartpageAnubisStep(`${STARTPAGE_BASE_URL}/`, (forceDirect) => ({
        ...requestOptions(forceDirect),
        headers: {
            ...requestOptions(forceDirect).headers,
            'Cookie': allCookies
        }
    }), 'Startpage Anubis home');
    const scCode = extractStartpageScToken(String(home2.data || ''));
    if (!scCode) {
        return null;
    }

    return { cookies: allCookies, scCode };
}

/**
 * 纯 HTTP 走通 Anubis 挑战，返回放行 cookie 与 sc token。
 * 并发调用共享同一 in-flight 预热（singleflight 去重），避免多个并发请求各自重复求解 PoW。
 */
export async function warmupWithAnubisPow(signal?: AbortSignal): Promise<AnubisSession | null> {
    if (signal?.aborted) {
        return null;
    }
    if (!inflightAnubisWarmup) {
        inflightAnubisWarmup = runAnubisPowWarmup(signal).finally(() => {
            inflightAnubisWarmup = null;
        });
    }
    return inflightAnubisWarmup;
}

