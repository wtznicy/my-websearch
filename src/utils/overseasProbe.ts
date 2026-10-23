import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { engineShouldUseProxy } from '../config.js';
import { AppError } from '../core/errors.js';
import { BROWSER_USER_AGENT } from './constants.js';
import { detectSystemProxy } from './systemProxy.js';
import { isChineseLocale } from './locale.js';

/**
 * 境外引擎可达性探测（方案二）：
 *
 * 当境外引擎（duckduckgo/brave/startpage）未配置走代理时，先探测直连是否可达：
 * - 直连可达（海外用户/专线）→ 正常搜索
 * - 直连不可达（国内无代理，被墙挂 15s 超时）→ 快速失败，报"需要代理或改用国内引擎"
 *   （避免直连挂满超时 × 多层重试拖累整次搜索，实测 bing+duckduckgo 无代理时整体 ~30s）
 *
 * 探测仅在引擎未走代理时发生：已显式配置代理（PROXY_URL / USE_PROXY=true）且引擎在白名单
 * （或白名单为空）时直接放行，不探测（代理可达性由代理保证，且代理链路延迟不影响探测阈值）。
 *
 * 阈值设计：单次 3s，失败重试 1 次（容错网络抖动），结果缓存 5 分钟
 * （避免 LLM 会话内多次搜索反复探测；开关代理后 TTL 过期自动重新探测）。
 */

const PROBE_TIMEOUT_MS = 3000;
const PROBE_MAX_RETRIES = 1;
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
// 失败结果短缓存：节点切换/网络恢复后 1 分钟内即可重新探测（此前一律 5 分钟，
// 一次瞬时失败会把引擎"锁死"5 分钟——实测踩过）
const PROBE_FAILURE_CACHE_TTL_MS = 60 * 1000;
const PROBE_MAX_ENTRIES = 20;

/** 探测目标：与各引擎实际请求的 host 保持一致（固定 https URL，无 SSRF 面） */
const PROBE_TARGETS: Record<'duckduckgo' | 'brave' | 'startpage', string> = {
    duckduckgo: 'https://duckduckgo.com/',
    brave: 'https://search.brave.com/',
    startpage: 'https://www.startpage.com/'
};

type ProbeState = { reachable: boolean; checkedAt: number };
const probeCache = new Map<string, ProbeState>();

/**
 * 代理探测用的 HttpsProxyAgent 缓存（按代理 URL 复用连接）。
 *
 * 为什么不用 axios 原生 `proxy` 选项：axios 会为该选项装一个 **http** Agent，
 * 对 https:// 目标直接抛 `ERR_INVALID_PROTOCOL: Protocol "https:" not supported`
 * （axios 1.20 实测），**请求根本没发出去** → 系统代理兜底被误判为"不可达"，
 * 于是"开了 Clash 但没配 PROXY_URL"时海外引擎全线被拦。这里改用与
 * httpRequest.ts 真实请求链路相同的 HttpsProxyAgent。
 */
const MAX_PROBE_PROXY_AGENTS = 16;
const probeProxyAgents = new Map<string, HttpsProxyAgent<string>>();

function getProbeProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
    const cached = probeProxyAgents.get(proxyUrl);
    if (cached) {
        probeProxyAgents.delete(proxyUrl);
        probeProxyAgents.set(proxyUrl, cached);
        return cached;
    }
    while (probeProxyAgents.size >= MAX_PROBE_PROXY_AGENTS) {
        const oldest = probeProxyAgents.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        probeProxyAgents.delete(oldest);
    }
    const agent = new HttpsProxyAgent(proxyUrl, { keepAlive: true, maxSockets: 4 });
    probeProxyAgents.set(proxyUrl, agent);
    return agent;
}

/**
 * 单次探测：任何 HTTP 响应（含 403/429）都说明链路可达，只有网络层失败才算不可达。
 * proxyUrl 提供时经该代理探测（用于系统代理兜底：用户开了 Clash 但未配 PROXY_URL 的场景）。
 */
async function probeOnce(url: string, proxyUrl?: string): Promise<boolean> {
    try {
        const agent = proxyUrl ? getProbeProxyAgent(proxyUrl) : undefined;
        await axios.get(url, {
            headers: { 'User-Agent': BROWSER_USER_AGENT },
            timeout: PROBE_TIMEOUT_MS,
            // 裸请求固定 URL：不依赖 buildAxiosRequestOptions（其代理路由会干扰"直连探测"语义）
            validateStatus: () => true,
            // 关闭 axios 对 env 代理变量的自动解析，代理只由上方 agent 决定
            proxy: false,
            ...(agent ? { httpAgent: agent, httpsAgent: agent } : {})
        });
        return true;
    } catch {
        return false;
    }
}

/** 等待任一探测成功（短路；其余探测在后台自然结束，请求轻量无害） */
async function anyProbeSucceeded(attempts: Array<Promise<boolean>>): Promise<boolean> {
    return new Promise((resolve) => {
        let pending = attempts.length;
        if (pending === 0) {
            resolve(false);
            return;
        }
        for (const attempt of attempts) {
            attempt
                .then((ok) => {
                    if (ok) {
                        resolve(true);
                    }
                })
                .catch(() => undefined)
                .finally(() => {
                    pending -= 1;
                    if (pending === 0) {
                        resolve(false);
                    }
                });
        }
    });
}

async function isDirectlyReachable(engine: 'duckduckgo' | 'brave' | 'startpage'): Promise<boolean> {
    const now = Date.now();
    const cached = probeCache.get(engine);
    if (cached) {
        const ttl = cached.reachable ? PROBE_CACHE_TTL_MS : PROBE_FAILURE_CACHE_TTL_MS;
        if (now - cached.checkedAt < ttl) {
            probeCache.delete(engine);
            probeCache.set(engine, cached);
            return cached.reachable;
        }
        probeCache.delete(engine);
    }

    // 直连与系统代理**并行**探测（有系统代理时），任一可达即放行：
    // 串行时国内无直连环境要先白等直连 3s×2=6s 才轮到代理，这 6s 会吃掉引擎的搜索预算。
    //
    // 直连的重试次数：没有系统代理时保留 1 次（可能是网络抖动，重试有意义）；
    // 有系统代理时降为 0 —— 说明用户本来就想走代理，直连失败一次基本是确定性的（被墙/无直连），
    // 再等 3s 只是把 DDG 的失败从 ~4s 拉到 ~7s；真能用的话并行中的代理探测会立刻成功。
    const systemProxy = await detectSystemProxy();
    // 有系统代理时两条路径都只探 1 次：它们本来就是并行兜底关系，
    // 任一条能通会立刻短路，重试只会在「双双失败」时把 3s 翻成 6s（实测 7.3s → 3.4s）。
    // 没有系统代理时保留 1 次重试：可能是网络抖动，没有第二条路可走。
    const probeRetries = systemProxy ? 0 : PROBE_MAX_RETRIES;
    const attempts: Array<Promise<boolean>> = [
        (async () => {
            let reachable = false;
            for (let attempt = 0; attempt <= probeRetries && !reachable; attempt += 1) {
                reachable = await probeOnce(PROBE_TARGETS[engine]);
            }
            return reachable;
        })()
    ];
    if (systemProxy) {
        attempts.push((async () => {
            let reachable = false;
            for (let attempt = 0; attempt <= probeRetries && !reachable; attempt += 1) {
                reachable = await probeOnce(PROBE_TARGETS[engine], systemProxy);
            }
            return reachable;
        })());
    }
    const reachable = await anyProbeSucceeded(attempts);

    if (probeCache.size >= PROBE_MAX_ENTRIES) {
        const oldest = probeCache.keys().next().value;
        if (oldest !== undefined) {
            probeCache.delete(oldest);
        }
    }
    probeCache.set(engine, { reachable, checkedAt: now });
    return reachable;
}

/**
 * 同步查询"该境外引擎此刻是否**已知**不可达"——只读缓存，不触发探测。
 *
 * 供编排层（级联候选、auto 默认路由）排除这类引擎：否则每一批级联都要等它
 * 探测 3s×2 次才失败（实测英文路由被拖到 20.7s）。保守判定：
 * - 引擎已配置走代理 → 不排除（可达性由代理保证，代理开关切换后应立刻恢复尝试）
 * - 无缓存记录 / 缓存说可达 / 失败缓存已过期（>1 分钟）→ 不排除
 * 也就是说它只用来**避免重复踩已知的坑**，不会改变首次探测行为。
 */
export function isKnownUnreachableOverseasEngine(engine: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(PROBE_TARGETS, engine)) {
        return false;
    }
    if (engineShouldUseProxy(engine)) {
        return false;
    }
    const now = Date.now();
    const cached = probeCache.get(engine);
    if (cached) {
        if (cached.reachable) {
            return false;
        }
        return now - cached.checkedAt < PROBE_FAILURE_CACHE_TTL_MS;
    }
    // 任一境外引擎刚探测出本机无直连且无可用系统代理（且尚无其他境外引擎探测成功）时，
    // 其余同批/后续批次的境外引擎共享该不可达结论，避免 duckduckgo 失败后 brave/startpage 再各自挂满 6s 探测
    let hasAnyFreshSuccess = false;
    let hasAnyFreshFailure = false;
    for (const state of probeCache.values()) {
        if (state.reachable && now - state.checkedAt < PROBE_CACHE_TTL_MS) {
            hasAnyFreshSuccess = true;
            break;
        }
        if (!state.reachable && now - state.checkedAt < PROBE_FAILURE_CACHE_TTL_MS) {
            hasAnyFreshFailure = true;
        }
    }
    return !hasAnyFreshSuccess && hasAnyFreshFailure;
}

/**
 * 供单元测试注入或清理境外可达性缓存
 */
export function __setOverseasReachableForTests(reachable: boolean | null): void {
    probeCache.clear();
    if (reachable === null) {
        return;
    }
    const now = Date.now();
    for (const key of Object.keys(PROBE_TARGETS)) {
        probeCache.set(key, { reachable, checkedAt: now });
    }
}

/**
 * 境外引擎可用性断言：调用方（引擎入口）在发起搜索前调用。
 * - 引擎已显式配置走代理 → 直接放行（不探测）
 * - 检测到系统代理 → 直接放行：系统代理的可用性交给真实请求判断。
 *   （此前用 3s 探测决定生死，代理冷启动稍慢就把可用代理误判为不可达，
 *    还会缓存失败 60s；实测 2.3s 的代理被 3s 阈值误杀。）
 * - 完全没有代理 → 探测直连，不可达时快速失败
 */
export async function assertOverseasEngineUsable(engine: 'duckduckgo' | 'brave' | 'startpage'): Promise<void> {
    if (engineShouldUseProxy(engine)) {
        return;
    }

    const systemProxy = await detectSystemProxy();
    if (systemProxy) {
        // 有系统代理就不再拦截：让真实请求（10s 预算、完整错误映射）去判断
        return;
    }

    const reachable = await isDirectlyReachable(engine);
    if (!reachable) {
        // 无代理且直连不可达：报明确错误
        const chineseLocale = isChineseLocale();
        throw new AppError({
            code: 'overseas_unreachable',
            retryable: false,
            status: 503,
            engine,
            hint: chineseLocale
                ? 'Turn on your proxy client\'s "system proxy" switch, or set PROXY_URL (e.g. PROXY_URL=http://127.0.0.1:7897).'
                : 'No proxy is configured (normal outside mainland China). Check your connection or try another engine (bing/duckduckgo/brave/github).',
            message: chineseLocale
                ? `${engine} is unreachable from your current network without a proxy. No system proxy was detected on this machine. ` +
                'Turn on your proxy client\'s "system proxy" switch, or set PROXY_URL to your proxy address (e.g. PROXY_URL=http://127.0.0.1:7897), ' +
                'or use domestic engines (bing/baidu/csdn/juejin/sogou) or exa (requires EXA_API_KEY). ' +
                'Then restart the MCP server so the new environment is picked up.'
                : `${engine} is unreachable from your current network. No system proxy was detected on this machine. ` +
                'No proxy is configured, which is the normal setup outside mainland China — so this is usually a local network/DNS problem rather than a missing proxy. ' +
                'Try another engine (bing/duckduckgo/brave/github) or retry in a moment.'
        });
    }
}
