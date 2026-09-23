import { config } from '../../config.js';
import { EngineSearchResponse, SearchResult } from '../../types.js';
import { createWreqSession, loadWreqModule } from '../bing/impersonate.js';
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

/** 把持久化的 cookie 逐条写回会话（wreq 的 setCookie 为三参数形式） */
function restoreCookies(session: { setCookie(name: string, value: string, url: string): void }, cookies: WreqCookie[]): void {
    for (const cookie of cookies) {
        try {
            const host = (cookie.domain || 'www.baidu.com').replace(/^\./, '');
            session.setCookie(cookie.name, cookie.value, `https://${host}/`);
        } catch {
            // 单条写入失败不影响其余 cookie
        }
    }
}

/**
 * 用 wreq-js（Chrome TLS/HTTP2 指纹 + 会话 cookie）执行百度搜索。
 * 分页抓取与 axios 路径一致；页面被反爬拦截时抛错，由调用方决定回退。
 */
export async function searchBaiduWithImpersonate(query: string, limit: number): Promise<EngineSearchResponse> {
    const mod = await loadWreqModule();
    if (!mod) {
        throw new Error('wreq-js is not available');
    }

    const session = await createWreqSession(mod as unknown as Parameters<typeof createWreqSession>[0]);
    try {
        // 会话 cookie：优先复用磁盘持久化的长期项（BAIDUID/BIDUPSID，省一次首页预热往返）；
        // 无持久化/已过期时走首页预热，并把长期项回写磁盘供下次进程复用
        const persistedCookies = await loadPersistedBaiduCookies();
        if (persistedCookies && persistedCookies.length > 0) {
            restoreCookies(session, persistedCookies);
        } else {
            try {
                await session.fetch(BAIDU_HOME_URL, { timeout: 15000 });
                await savePersistedBaiduCookies(session.getAllCookies());
            } catch (error) {
                console.warn('Baidu impersonate home page request failed, continuing with search:', error instanceof Error ? error.message : String(error));
            }
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
        return finalResults;
    } finally {
        await session.close().catch(() => undefined);
    }
}
