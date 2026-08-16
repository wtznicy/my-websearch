import * as zlib from 'node:zlib';
import { config } from '../../config.js';
import { SearchResult } from '../../types.js';
import { parseBingSearchResults } from './parser.js';

/**
 * Bing HTTP 模式的浏览器指纹请求层（curl-cffi-node）。
 *
 * 背景：Bing 对纯 HTTP 请求按请求特征（TLS/JA3、HTTP/2、头顺序等）做软降级——
 * 同一 IP 下真实浏览器（Playwright）返回完整结果，而 Node 默认 TLS（OpenSSL）
 * 的请求会被降级为无关结果。curl-cffi-node 通过 napi-rs 绑定 curl-impersonate，
 * 在 TLS/HTTP2 层 1:1 复刻 Chrome 指纹，规避该降级（实测 2/3 请求拿到完整结果，
 * 远好于默认客户端的稳定降级）。
 *
 * 设计要点：
 * - 原生模块懒加载检测，不可用时由调用方回退 axios（不影响现有行为）
 * - 复用 curl-impersonate 注入的浏览器默认头（defaultHeaders），不手动覆盖
 * - 响应可能为 br/gzip 压缩（Chrome 默认 Accept-Encoding），需要手动解压
 * - TLS 证书验证默认开启；部分平台（如 Windows）curl-impersonate 找不到系统 CA
 *   报 curl 60 时，自动降级关闭验证重试一次（搜索页面为公开内容，风险可控）
 */

type ImpersonateModule = {
    Session: new (options: { impersonate: string; verify?: boolean }) => ImpersonateSession;
};

type ImpersonateSession = {
    get(url: string): Promise<ImpersonateResponse>;
};

type ImpersonateResponse = {
    status: number;
    headers: { get(name: string): string | null };
    buffer(): Buffer;
};

let cachedModule: ImpersonateModule | null = null;
let availabilityPromise: Promise<boolean> | null = null;

/** 检测 curl-cffi-node 原生模块是否可用（懒加载 + 结果缓存，进程内只探测一次） */
export function isImpersonateAvailable(): Promise<boolean> {
    if (!availabilityPromise) {
        availabilityPromise = (async () => {
            try {
                const mod = await import('curl-cffi-node');
                // 构造一次 Session 确认原生绑定真实可用（部分平台 prebuild 缺失时会抛错）
                new mod.Session({ impersonate: config.bingImpersonateTarget, verify: true });
                cachedModule = mod;
                return true;
            } catch (error) {
                console.warn(`curl-cffi-node unavailable, Bing will fall back to the default HTTP client: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
        })();
    }
    return availabilityPromise;
}

function buildImpersonateSearchUrl(query: string, pageNumber: number): string {
    const url = new URL('https://cn.bing.com/search');
    url.searchParams.set('q', query);
    if (url.hostname.includes('cn.bing.com')) {
        url.searchParams.set('setlang', 'zh-CN');
        url.searchParams.set('ensearch', '0');
    }
    url.searchParams.set('first', String(1 + pageNumber * 10));
    return url.toString();
}

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
        console.warn(`Bing impersonate response decode failed (${encoding}): ${error instanceof Error ? error.message : String(error)}`);
    }
    return buf.toString('utf8');
}

function isAntiBotPage(html: string): boolean {
    const title = (html.match(/<title>(.*?)<\/title>/i) || [])[1]?.toLowerCase() ?? '';
    return /captcha|verify|access denied|blocked|验证|人机验证/.test(title) && !html.includes('b_algo');
}

/** 记录 TLS 验证是否曾在当前进程失败过（如 Windows 找不到系统 CA）。
 * 失败过一次后直接跳过 verify:true，避免每次请求都先失败再重试。 */
let tlsVerificationFailed = false;

async function requestWithTlsFallback(sessionFactory: (verify: boolean) => ImpersonateSession, url: string): Promise<ImpersonateResponse> {
    const verify = !tlsVerificationFailed;
    try {
        return await sessionFactory(verify).get(url);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // curl 60 = 证书验证失败；部分平台 curl-impersonate 找不到系统 CA（如 Windows）
        if (verify && (message.includes('(60)') || /SSL|CERT_|certificate/i.test(message))) {
            tlsVerificationFailed = true;
            console.warn('Bing impersonate TLS verification failed (likely missing system CA), retrying without verification: ' + message);
            return await sessionFactory(false).get(url);
        }
        throw error;
    }
}

/**
 * 用 curl-cffi-node（Chrome TLS/HTTP2 指纹）执行 Bing 搜索。
 * 分页抓取与 axios 路径一致；页面被反爬拦截时抛错，由调用方决定回退。
 */
export async function searchBingWithImpersonate(query: string, limit: number): Promise<SearchResult[]> {
    if (!cachedModule) {
        throw new Error('curl-cffi-node is not available');
    }

    const sessionFactory = (verify: boolean) => new cachedModule!.Session({ impersonate: config.bingImpersonateTarget, verify });
    // 同一会话内复用连接（更接近真实浏览器的连接池行为）
    let allResults: SearchResult[] = [];
    let pageNumber = 0;

    while (allResults.length < limit) {
        const url = buildImpersonateSearchUrl(query, pageNumber);
        const response = await requestWithTlsFallback(sessionFactory, url);
        const html = decodeResponseBody(response);

        if (isAntiBotPage(html)) {
            throw new Error('Bing returned a verification or anti-bot page in impersonate mode');
        }

        const results = parseBingSearchResults(html, limit - allResults.length);
        allResults = allResults.concat(results);

        if (results.length === 0) {
            break;
        }

        pageNumber += 1;
    }

    return allResults.slice(0, limit);
}
