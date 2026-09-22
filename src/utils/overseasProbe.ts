import axios from 'axios';
import { engineShouldUseProxy } from '../config.js';
import { BROWSER_USER_AGENT } from './constants.js';
import { detectSystemProxy, parseProxyUrl } from './systemProxy.js';

/**
 * 境外引擎可达性探测（方案二）：
 *
 * 当境外引擎（duckduckgo/brave/startpage）未配置走代理时，先探测直连是否可达：
 * - 直连可达（海外用户/专线）→ 正常搜索
 * - 直连不可达（国内无代理，被墙挂 15s 超时）→ 快速失败，报"需要代理或改用国内引擎"
 *   （避免直连挂满超时 × 多层重试拖累整次搜索，实测 bing+duckduckgo 无代理时整体 ~30s）
 *
 * 探测仅在引擎未走代理时发生：USE_PROXY=true 且引擎在白名单（或白名单为空）时
 * 直接放行，不探测（代理可达性由代理保证，且代理链路延迟不影响探测阈值）。
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
 * 单次探测：任何 HTTP 响应（含 403/429）都说明链路可达，只有网络层失败才算不可达。
 * proxyUrl 提供时经该代理探测（用于系统代理兜底：用户开了 Clash 但未配 USE_PROXY 的场景）。
 */
async function probeOnce(url: string, proxyUrl?: string): Promise<boolean> {
    try {
        const proxy = proxyUrl ? parseProxyUrl(proxyUrl) : undefined;
        await axios.get(url, {
            headers: { 'User-Agent': BROWSER_USER_AGENT },
            timeout: PROBE_TIMEOUT_MS,
            // 裸请求固定 URL：不依赖 buildAxiosRequestOptions（其代理路由会干扰"直连探测"语义）
            validateStatus: () => true,
            ...(proxy ? { proxy } : {})
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
            return cached.reachable;
        }
    }

    // 直连与系统代理**并行**探测（有系统代理时），任一可达即放行：
    // 串行时国内无直连环境要先白等直连 3s×2=6s 才轮到代理，这 6s 会吃掉引擎的搜索预算
    const systemProxy = await detectSystemProxy();
    const attempts: Array<Promise<boolean>> = [
        (async () => {
            let reachable = false;
            for (let attempt = 0; attempt <= PROBE_MAX_RETRIES && !reachable; attempt += 1) {
                reachable = await probeOnce(PROBE_TARGETS[engine]);
            }
            return reachable;
        })()
    ];
    if (systemProxy) {
        attempts.push((async () => {
            let reachable = false;
            for (let attempt = 0; attempt <= PROBE_MAX_RETRIES && !reachable; attempt += 1) {
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
 * 境外引擎可用性断言：调用方（引擎入口）在发起搜索前调用。
 * - 引擎已配置走代理 → 直接放行（不探测）
 * - 未配置代理 → 探测直连，不可达时立即抛错（快速失败）
 */
export async function assertOverseasEngineUsable(engine: 'duckduckgo' | 'brave' | 'startpage'): Promise<void> {
    if (engineShouldUseProxy(engine)) {
        return;
    }
    const reachable = await isDirectlyReachable(engine);
    if (!reachable) {
        // 配置类/网络环境类确定性错误：标记不可重试，多引擎搜索时其他引擎（如 bing）不受影响
        const error = new Error(
            `${engine} is unreachable from your current network without a proxy. ` +
            'Enable USE_PROXY=true + PROXY_URL (and include this engine in PROXY_ENGINES if that whitelist is set), ' +
            'or use domestic engines (bing/baidu/csdn/juejin/sogou) or exa (requires EXA_API_KEY). ' +
            'Already running a proxy client? This server ignores system proxy env vars by design — check that USE_PROXY/PROXY_URL are set in your MCP client config, then restart the MCP server.'
        );
        (error as any).retryable = false;
        throw error;
    }
}
