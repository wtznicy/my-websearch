import { config } from '../../config.js';
import { EngineSearchResponse, SearchResult } from '../../types.js';
import { createWreqSession, loadWreqModule } from '../bing/impersonate.js';
import type { WreqSession } from '../bing/impersonate.js';
export { isImpersonateAvailable } from '../bing/impersonate.js';
import { isBaiduAntiBotPage, parseBaiduResultsPage } from './parser.js';
import { loadPersistedBaiduCookies, savePersistedBaiduCookies, WreqCookie } from '../../utils/cookieStore.js';

/**
 * Baidu HTTP 模式的浏览器指纹请求层（wreq-js，Rust 实现）。
 *
 * 背景：百度对纯 HTTP 请求（无会话 cookie、TLS/JA3 非浏览器指纹）直接返回
 * <meta refresh> 跳转页（安全验证/首页），解析不到任何结果。wreq-js 在 TLS/HTTP2
 * 层复刻 Chrome 指纹，且 Session 自带 cookie jar——先访问一次百度首页种下
 * BAIDUID/BIDUPSID，再带会话 cookie 请求搜索页，与真实浏览器的首次访问路径一致。
 *
 * 从 curl-cffi-node 迁移的收益同 bing：原生异步（不再阻塞事件循环）、上游活跃、
 * Rust 自带根证书（无 curl 60 降级路径）。cookie 持久化改用 wreq 的对象数组格式。
 */

const BAIDU_HOME_URL = 'https://www.baidu.com/';

/**
 * 会话里是否已有百度的会话 cookie（BAIDUID 系）。
 *
 * 这是"cookie 注入成功"的**不变量校验**：只信 store 的返回长度是不够的——
 * 2026-09 的故障正是"磁盘返回 3 条（判据为真）→ 跳过预热，但注入全部失败 → 每次搜索都是零 cookie 裸刷"，
 * 最终把出口 IP 刷成了百度的人机验证名单。任何一次注入失败都要能让预热兜住。
 */
export function hasBaiduSessionCookie(cookies: Array<{ name?: string }>): boolean {
    return cookies.some((cookie) => typeof cookie?.name === 'string' && /^BAIDUID/i.test(cookie.name));
}

/** 把持久化的 cookie 逐条写回会话（wreq 的 setCookie 为三参数形式）；返回失败条数并告警 */
function restoreCookies(session: { setCookie(name: string, value: string, url: string): void }, cookies: WreqCookie[]): number {
    const failures: string[] = [];
    for (const cookie of cookies) {
        try {
            const host = (cookie.domain || 'www.baidu.com').replace(/^\./, '');
            session.setCookie(cookie.name, cookie.value, `https://${host}/`);
        } catch (error) {
            // 不中断其余 cookie，但**必须留痕**：此前这里是无输出的空 catch，
            // 导致"注入全失败"被静默吞掉、并被误判为"cookie 已在会话里"
            failures.push(`${cookie?.name ?? '(无名)'}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (failures.length > 0) {
        console.warn(`Baidu cookie restore: ${failures.length}/${cookies.length} 条注入失败（${failures.slice(0, 3).join('; ')}）`);
    }
    return failures.length;
}

let cachedBaiduSession: WreqSession | null = null;
let baiduSessionPromise: Promise<WreqSession | null> | null = null;
let baiduSessionWarmedUp = false;

async function getOrCreateBaiduSession(): Promise<WreqSession | null> {
    if (cachedBaiduSession) {
        return cachedBaiduSession;
    }
    if (baiduSessionPromise) {
        return baiduSessionPromise;
    }
    baiduSessionPromise = (async () => {
        const mod = await loadWreqModule();
        if (!mod) {
            return null;
        }
        try {
            cachedBaiduSession = await createWreqSession(mod as unknown as Parameters<typeof createWreqSession>[0], 'baidu');
            return cachedBaiduSession;
        } catch (error) {
            console.warn('Baidu wreq session creation failed:', error instanceof Error ? error.message : String(error));
            return null;
        } finally {
            baiduSessionPromise = null;
        }
    })();
    return baiduSessionPromise;
}

export function invalidateBaiduSession(): void {
    if (cachedBaiduSession) {
        cachedBaiduSession.close().catch(() => undefined);
        cachedBaiduSession = null;
    }
    baiduSessionWarmedUp = false;
}

/**
 * 用 wreq-js（Chrome TLS/HTTP2 指纹 + 会话 cookie）执行百度搜索。
 * 进程级复用会话以复用 TLS 连接与在内存 cookie，避免重复握手与多余首页预热。
 */
export async function searchBaiduWithImpersonate(query: string, limit: number): Promise<EngineSearchResponse> {
    const session = await getOrCreateBaiduSession();
    if (!session) {
        throw new Error('wreq-js is not available');
    }

    try {
        // 会话 cookie：优先复用会话内现存 cookie；若尚未预热或缺少 BAIDUID 时才从持久化读取或首页预热
        if (!baiduSessionWarmedUp || !hasBaiduSessionCookie(session.getAllCookies())) {
            const persistedCookies = await loadPersistedBaiduCookies();
            if (persistedCookies && persistedCookies.length > 0) {
                restoreCookies(session, persistedCookies);
            }
            if (!hasBaiduSessionCookie(session.getAllCookies())) {
                try {
                    await session.fetch(BAIDU_HOME_URL, { timeout: 15000 });
                    await savePersistedBaiduCookies(session.getAllCookies());
                } catch (error) {
                    console.warn('Baidu impersonate home page request failed, continuing with search:', error instanceof Error ? error.message : String(error));
                }
            }
            baiduSessionWarmedUp = true;
        }

        const allResults: SearchResult[] = [];
        const seenUrls = new Set<string>();
        let directAnswer: string | undefined;
        let pageNumber = 0;

        while (allResults.length < limit) {
            const url = `${BAIDU_HOME_URL}s?wd=${encodeURIComponent(query)}&pn=${pageNumber * 10}&ie=utf-8&tn=baiduhome_pg`;
            const response = await session.fetch(url, { timeout: 15000 });
            const html = await response.text();

            if (isBaiduAntiBotPage(html)) {
                throw new Error('Baidu returned an anti-bot or redirect page in impersonate mode (likely missing cookies or verification)');
            }

            const results = await parseBaiduResultsPage(html, seenUrls);
            if (!directAnswer && results.directAnswer) {
                directAnswer = results.directAnswer;
            }
            allResults.push(...results);

            if (results.length === 0) {
                break;
            }

            pageNumber += 1;
        }

        const finalResults = allResults.slice(0, limit) as EngineSearchResponse;
        if (directAnswer) {
            finalResults.directAnswer = directAnswer;
        }
        if (finalResults.length > 0) {
            await savePersistedBaiduCookies(session.getAllCookies());
        }
        return finalResults;
    } catch (error) {
        if (error instanceof Error && /socket|tls|econnreset|pipe|closed|reset/i.test(error.message)) {
            invalidateBaiduSession();
        }
        throw error;
    }
}
