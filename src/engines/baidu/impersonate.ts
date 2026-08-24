import * as zlib from 'node:zlib';
import { config } from '../../config.js';
import { SearchResult } from '../../types.js';
import { isImpersonateAvailable } from '../bing/impersonate.js';
export { isImpersonateAvailable } from '../bing/impersonate.js';
import { isBaiduAntiBotPage, parseBaiduResultsPage } from './parser.js';

/**
 * Baidu HTTP 模式的浏览器指纹请求层（curl-cffi-node）。
 *
 * 背景：百度对纯 HTTP 请求（无会话 cookie、TLS/JA3 非浏览器指纹）直接返回
 * <meta refresh> 跳转页（安全验证/首页），解析不到任何结果。curl-cffi-node
 * 的 Session 在 TLS/HTTP2 层复刻 Chrome 指纹，且自带 cookie 持久化——
 * 先访问一次百度首页种下 BAIDUID/BIDUPSID，再带会话 cookie 请求搜索页，
 * 与真实浏览器的首次访问路径一致。
 *
 * 设计要点：
 * - 可用性检测复用 bing 的进程级探测（同一原生模块，探测结果天然共享）
 * - 每页结果解析复用 parser.ts，与 axios 路径输出结构一致
 * - 响应可能为 br/gzip 压缩（Chrome 默认 Accept-Encoding），需要手动解压
 * - TLS 证书验证失败（如 Windows 找不到系统 CA 报 curl 60）时降级关闭验证
 *   重试一次，并保留会话 cookie（搜索页面为公开内容，风险可控）
 */

type ImpersonateModule = {
    Session: new (options: { impersonate: string; verify?: boolean; timeout?: number }) => ImpersonateSession;
};

type ImpersonateSession = {
    get(url: string, options?: { params?: Record<string, string | number>; timeout?: number }): Promise<ImpersonateResponse>;
    cookies: string[];
    importCookies(cookies: string[]): void;
};

type ImpersonateResponse = {
    status: number;
    headers: { get(name: string): string | null };
    buffer(): Buffer;
};

let cachedModule: ImpersonateModule | null = null;

async function loadImpersonateModule(): Promise<ImpersonateModule | null> {
    if (cachedModule) {
        return cachedModule;
    }
    if (!(await isImpersonateAvailable())) {
        return null;
    }
    cachedModule = (await import('curl-cffi-node')) as unknown as ImpersonateModule;
    return cachedModule;
}

/** 记录 TLS 验证是否曾在当前进程失败过（如 Windows 找不到系统 CA）。
 * 失败后直接跳过 verify:true 避免每次请求都先失败再重试；
 * 带冷却期：冷却结束后重置标志，允许重新尝试证书验证（系统 CA 可能已修复）。 */
let tlsVerificationFailed = false;
let tlsVerificationFailedAt = 0;
const TLS_VERIFY_RETRY_MS = 10 * 60 * 1000;

function decodeResponseBody(response: ImpersonateResponse): string {
    const buf = response.buffer();
    const encoding = String(response.headers.get('content-encoding') || '').toLowerCase();
    try {
        if (encoding.includes('br')) {
            return zlib.brotliDecompressSync(buf).toString('utf8');
        }
        if (encoding.includes('gzip')) {
            return zlib.gunzipSync(buf).toString('utf8');
        }
        if (encoding.includes('deflate')) {
            return zlib.inflateSync(buf).toString('utf8');
        }
    } catch (error) {
        console.warn(`Baidu impersonate response decode failed (${encoding}): ${error instanceof Error ? error.message : String(error)}`);
    }
    return buf.toString('utf8');
}

/**
 * 用 curl-cffi-node（Chrome TLS/HTTP2 指纹 + 会话 cookie）执行百度搜索。
 * 分页抓取与 axios 路径一致；页面被反爬拦截时抛错，由调用方决定回退。
 */
export async function searchBaiduWithImpersonate(query: string, limit: number): Promise<SearchResult[]> {
    const mod = await loadImpersonateModule();
    if (!mod) {
        throw new Error('curl-cffi-node is not available');
    }

    let session = new mod.Session({
        impersonate: config.bingImpersonateTarget,
        verify: !tlsVerificationFailed,
        timeout: 15
    });

    // 证书验证失败时重建会话并保留已种下的 cookie
    const performWithTlsFallback = async (run: () => Promise<ImpersonateResponse>): Promise<ImpersonateResponse> => {
        if (tlsVerificationFailed && Date.now() - tlsVerificationFailedAt > TLS_VERIFY_RETRY_MS) {
            tlsVerificationFailed = false;
        }
        try {
            return await run();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // curl 60 = 证书验证失败；部分平台 curl-impersonate 找不到系统 CA（如 Windows）
            if (!tlsVerificationFailed && (message.includes('(60)') || /SSL|CERT_|certificate/i.test(message))) {
                tlsVerificationFailed = true;
                tlsVerificationFailedAt = Date.now();
                console.warn('Baidu impersonate TLS verification failed (likely missing system CA), retrying without verification: ' + message);
                const cookies = session.cookies;
                session = new mod.Session({
                    impersonate: config.bingImpersonateTarget,
                    verify: false,
                    timeout: 15
                });
                if (cookies.length > 0) {
                    session.importCookies(cookies);
                }
                return await run();
            }
            throw error;
        }
    };

    // 首访首页让服务端种下 BAIDUID/BIDUPSID 会话 cookie；失败不致命（部分网络下首页偶发拦截），继续搜索
    try {
        await performWithTlsFallback(() => session.get('https://www.baidu.com/', { timeout: 15 }));
    } catch (error) {
        console.warn('Baidu impersonate home page request failed, continuing with search:', error instanceof Error ? error.message : String(error));
    }

    const allResults: SearchResult[] = [];
    const seenUrls = new Set<string>();
    let pageNumber = 0;

    while (allResults.length < limit) {
        const response = await performWithTlsFallback(() => session.get('https://www.baidu.com/s', {
            params: {
                wd: query,
                pn: pageNumber * 10,
                ie: 'utf-8',
                tn: 'baiduhome_pg'
            },
            timeout: 15
        }));
        const html = decodeResponseBody(response);

        if (isBaiduAntiBotPage(html)) {
            throw new Error('Baidu returned an anti-bot or redirect page in impersonate mode (likely missing cookies or verification)');
        }

        const results = await parseBaiduResultsPage(html, seenUrls);
        allResults.push(...results);

        if (results.length === 0) {
            break;
        }

        pageNumber += 1;
    }

    return allResults.slice(0, limit);
}
