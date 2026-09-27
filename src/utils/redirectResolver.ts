import axios from 'axios';
import { buildAxiosRequestOptions } from './httpRequest.js';
import { mapWithConcurrencyBudget } from './concurrency.js';
import { DEFAULT_DESKTOP_UA } from './userAgents.js';

export type RedirectResolveOptions = {
    engine?: string;
    userAgent?: string;
    timeoutMs?: number;
    maxRedirects?: number;
};

export type BatchRedirectOptions = {
    budgetMs?: number;
    concurrency?: number;
};

/**
 * 通过 HEAD/GET 请求解析 HTTP 3xx 重定向的最终真实 URL。
 * 若请求失败或未重定向，安全回退到原链接。
 */
export async function resolveHttpRedirectUrl(
    linkUrl: string,
    options: RedirectResolveOptions = {}
): Promise<string> {
    const {
        engine = 'default',
        userAgent = DEFAULT_DESKTOP_UA,
        timeoutMs = 8000,
        maxRedirects = 3
    } = options;

    try {
        const response = await axios.head(
            linkUrl,
            buildAxiosRequestOptions({
                engine,
                trustedStaticHost: true,
                headers: { 'User-Agent': userAgent },
                maxRedirects,
                timeout: timeoutMs,
                validateStatus: (status: number) => status >= 200 && status < 400
            })
        );

        const finalUrl = response.request?.res?.responseUrl
            ?? (typeof response.request?.res?.headers?.location === 'string'
                ? response.request.res.headers.location
                : undefined);

        if (typeof finalUrl === 'string' && finalUrl.startsWith('http')) {
            return finalUrl;
        }

        return linkUrl;
    } catch {
        return linkUrl;
    }
}

/**
 * 从 HTML 文本中提取页面内 JS (window.location.replace) 或 meta refresh 的重定向目标。
 */
export function extractMetaOrJsRedirect(html: string): string | null {
    if (!html) {
        return null;
    }

    const replaceMatch = html.match(/window\.location\.replace\(\s*["']([^"']+)["']\s*\)/i);
    const refreshMatch = html.match(/http-equiv=["']refresh["'][^>]*content=["']\d*;\s*URL=['"]?([^'">\s]+)/i);
    const target = (replaceMatch?.[1] ?? refreshMatch?.[1] ?? '').trim();

    if (/^https?:\/\//i.test(target)) {
        return target;
    }

    return null;
}

/**
 * 带并发与时间预算并发解析一批链接，超预算项自动回退为原 URL。
 */
export async function resolveBatchRedirects(
    urls: string[],
    resolver: (url: string) => Promise<string>,
    options: BatchRedirectOptions = {}
): Promise<string[]> {
    const {
        budgetMs = 2000,
        concurrency = 4
    } = options;

    return mapWithConcurrencyBudget(
        urls,
        concurrency,
        resolver,
        budgetMs,
        (original) => original
    );
}
