import { config } from '../../config.js';
import { EngineSearchResponse, SearchResult } from '../../types.js';
import { parseBingSearchResults } from './parser.js';

/**
 * Bing HTTP 模式的浏览器指纹请求层（wreq-js，Rust 实现）。
 *
 * 背景：Bing 对纯 HTTP 请求按请求特征（TLS/JA3、HTTP/2、头顺序等）做软降级——
 * 同一 IP 下真实浏览器（Playwright）返回完整结果，而 Node 默认 TLS（OpenSSL）
 * 的请求会被降级为无关结果。wreq-js 通过 Rust 的 wreq 客户端在 TLS/HTTP2 层
 * 复刻 Chrome 指纹，规避该降级（spike 实测：与 curl-cffi-node 等价——同为
 * 10 条完整结果、无验证码、首条相同）。
 *
 * 为什么从 curl-cffi-node 迁移（2026-09）：
 * - curl-cffi-node 的 `Session.get()` 是**同步阻塞 FFI**（实测单次请求阻塞事件循环
 *   2166ms），并发引擎互相拖累；wreq-js 是原生 Promise 异步（同步段 0ms）
 * - 上游停更 5 个月（4 stars，Linux binding 的 libidn2 issue 无人处理）
 * - wreq-js 由 Rust 自带根证书（rustls/webpki）——不再需要 Windows 系统 CA 导出
 *   与 curl 60 的降级重试路径
 *
 * 设计要点：
 * - 原生模块懒加载检测，不可用时由调用方回退 axios（不影响现有行为）
 * - createSession 复用连接（实测复用后 1.0~1.2s/请求；顶层 fetch 每次重新握手会慢 2~3 倍）
 * - 响应自动解压（无需手动 br/gzip 处理）
 * - 会话用完显式 close()
 */

type WreqModule = {
    createSession: (options: { browser: string; os?: string }) => Promise<WreqSession>;
};

type WreqSession = {
    fetch(url: string, options?: { timeout?: number; headers?: Record<string, string> }): Promise<WreqResponse>;
    getAllCookies(): Array<{ name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expiresAtMs?: number }>;
    setCookie(name: string, value: string, url: string): void;
    close(): Promise<void>;
};

type WreqResponse = {
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
};

let cachedModule: WreqModule | null = null;
let availabilityPromise: Promise<boolean> | null = null;

/** 用配置的 profile 构造会话（上游类型把 browser/os 收窄为字符串联合，此处集中注入） */
export async function createWreqSession(mod: WreqModule): Promise<WreqSession> {
    return mod.createSession({ browser: config.impersonateBrowser, os: config.impersonateOs });
}

/** 检测 wreq-js 原生模块是否可用（懒加载 + 结果缓存，进程内只探测一次） */
export function isImpersonateAvailable(): Promise<boolean> {
    if (!availabilityPromise) {
        availabilityPromise = (async () => {
            try {
                const mod = await import('wreq-js');
                // 创建并关闭一次会话，确认原生 binding 真实可用（平台包缺失时会抛错）
                const probe = await createWreqSession(mod as unknown as WreqModule);
                await probe.close();
                cachedModule = mod as unknown as WreqModule;
                return true;
            } catch (error) {
                console.warn(`wreq-js unavailable, Bing will fall back to the default HTTP client: ${error instanceof Error ? error.message : String(error)}`);
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

function isAntiBotPage(html: string): boolean {
    const title = (html.match(/<title>(.*?)<\/title>/i) || [])[1]?.toLowerCase() ?? '';
    return /captcha|verify|access denied|blocked|验证|人机验证/.test(title) && !html.includes('b_algo');
}

/** 供百度 impersonate 层复用（同一原生模块） */
export async function loadWreqModule(): Promise<WreqModule | null> {
    if (!(await isImpersonateAvailable())) {
        return null;
    }
    return cachedModule;
}

export type { WreqSession, WreqResponse };

/**
 * 用 wreq-js（Chrome TLS/HTTP2 指纹）执行 Bing 搜索。
 * 分页抓取与 axios 路径一致；页面被反爬拦截时抛错，由调用方决定回退。
 */
export async function searchBingWithImpersonate(query: string, limit: number): Promise<EngineSearchResponse> {
    const mod = await loadWreqModule();
    if (!mod) {
        throw new Error('wreq-js is not available');
    }

    const session = await createWreqSession(mod as unknown as WreqModule);
    try {
        let allResults: SearchResult[] = [];
        let directAnswer: string | undefined;
        let pageNumber = 0;

        while (allResults.length < limit) {
            const url = buildImpersonateSearchUrl(query, pageNumber);
            const response = await session.fetch(url, { timeout: 15000 });
            const html = await response.text();

            if (isAntiBotPage(html)) {
                throw new Error('Bing returned a verification or anti-bot page in impersonate mode');
            }

            const results = parseBingSearchResults(html, limit - allResults.length);
            if (!directAnswer && results.directAnswer) {
                directAnswer = results.directAnswer;
            }
            allResults = allResults.concat(results);

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
