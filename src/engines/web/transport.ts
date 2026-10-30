import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { config } from '../../config.js';
import { buildAxiosRequestOptions, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { assertPublicHttpUrl } from '../../utils/urlSafety.js';
import {
    fetchPageHtmlWithBrowser,
    getBrowserCookieHeader,
    looksLikeBotChallengePage
} from '../../utils/browserCookies.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';
import { resolveAcceptLanguage } from '../../utils/locale.js';
import { AppError } from '../../core/errors.js';
import {
    DEFAULT_TIMEOUT_MS,
    FETCH_WEB_BROWSER_BUDGET_MS,
    HtmlExtractionResult,
    MAX_DOWNLOAD_BYTES
} from './types.js';
import { looksLikeHtml, MIN_METADATA_FALLBACK_CHARS } from './extraction.js';

export function buildRequestOptions(
    cookieHeader?: string,
    forceDirect = false,
    signal?: AbortSignal,
    maxBytes = MAX_DOWNLOAD_BYTES,
    options: { preferHtml?: boolean } = {}
): AxiosRequestConfig {
    // 默认优先 Markdown：站点做了内容协商时直接拿干净 Markdown，省去正文提取。
    // 但 extract / selector / readability / includeLinks 依赖真实 DOM，必须先要 HTML，
    // 否则站点会返回 text/markdown（实测 benchlm.ai），导致 extract 直接失败。
    const accept = options.preferHtml
        ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        : 'text/markdown,text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.8';
    const headers: Record<string, string> = {
        'User-Agent': DEFAULT_DESKTOP_UA,
        'Accept': accept,
        'Accept-Language': resolveAcceptLanguage()
    };
    // 国内站点（.cn/已知国内域名）直连，不因全局 USE_PROXY 走代理——代理挂掉时国内抓取不受影响
    const requestOptions = buildAxiosRequestOptions({
        allowInsecureTls: config.fetchWebAllowInsecureTls,
        decompress: true,
        headers,
        forceDirect,
        maxBodyLength: maxBytes,
        maxContentLength: maxBytes,
        maxRedirects: 5,
        // arraybuffer 以便按页面声明的 charset 解码（axios 的 text 模式固定按 UTF-8，GBK 中文站会乱码）
        responseType: 'arraybuffer',
        timeout: DEFAULT_TIMEOUT_MS,
        signal
    });

    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    return requestOptions;
}

/**
 * 从 Content-Type 头或 HTML meta 中探测 charset，并用 TextDecoder 解码原始字节。
 * 中文站点常用 GBK/GB2312，axios 的 text 模式固定按 UTF-8 会导致乱码。
 */
export function decodeResponseBuffer(buffer: ArrayBuffer | Uint8Array, contentType: string): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    // 1) 从 Content-Type 头提取 charset
    let charset = '';
    const charsetMatch = contentType.match(/charset=["']?([\w-]+)["']?/i);
    if (charsetMatch?.[1]) {
        charset = charsetMatch[1];
    }

    // 2) 从 HTML 前 1024 字节的 meta charset 提取
    if (!charset) {
        const headSample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 1024));
        const metaMatch = headSample.match(/<meta[^>]+charset=["']?([\w-]+)["']?/i);
        if (metaMatch?.[1]) {
            charset = metaMatch[1];
        }
    }

    // 3) 归一化并解码；GBK/GB2312/GB18030 都按 GB18030 处理（超集）
    const normalized = charset.toLowerCase();
    try {
        if (normalized === 'gbk' || normalized === 'gb2312' || normalized === 'gb18030' || normalized === 'gb_2312') {
            return new TextDecoder('gb18030').decode(bytes);
        }
        if (normalized && normalized !== 'utf-8' && normalized !== 'utf8') {
            return new TextDecoder(normalized).decode(bytes);
        }
    } catch {
        // 未知编码或 TextDecoder 不支持，回退 UTF-8
    }
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 统一把响应体解码为字符串：responseType 为 arraybuffer 时按页面 charset 解码；
 * 字符串原样返回；其他类型（JSON 等）转为格式化文本。
 * 主请求与 cookie 重试都必须走这里，否则 Buffer 会被 JSON.stringify 成数字数组。
 */
export function decodeRawResponse(response: AxiosResponse, contentType: string): string {
    return response.data instanceof ArrayBuffer || response.data instanceof Uint8Array
        ? decodeResponseBuffer(response.data, contentType)
        : typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data, null, 2);
}

export function shouldTryBrowserHtmlFallback(contentType: string, raw: string, extraction?: HtmlExtractionResult): boolean {
    if (looksLikeBotChallengePage(raw)) {
        return true;
    }

    if (contentType.includes('text/html') || looksLikeHtml(raw)) {
        return extraction?.mode === 'metadata' && extraction.text.length < MIN_METADATA_FALLBACK_CHARS;
    }

    return false;
}

let browserHtmlFetcher: typeof fetchPageHtmlWithBrowser = fetchPageHtmlWithBrowser;

export async function fetchHtmlViaBrowser(
    url: string,
    signal?: AbortSignal
): Promise<{ contentType: string; finalUrl: string; raw: string; title: string } | undefined> {
    try {
        const browserPage = await browserHtmlFetcher(url, signal);
        assertPublicHttpUrl(browserPage.finalUrl, 'Final URL');

        return {
            contentType: 'text/html; charset=utf-8',
            finalUrl: browserPage.finalUrl,
            raw: browserPage.html,
            title: browserPage.title
        };
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        return undefined;
    }
}

let browserCookieHeaderGetter = getBrowserCookieHeader;

export function __setBrowserCookieHeaderForTests(getter?: typeof getBrowserCookieHeader): void {
    browserCookieHeaderGetter = getter || getBrowserCookieHeader;
}

export function __setBrowserHtmlFetcherForTests(fetcher?: typeof fetchPageHtmlWithBrowser): void {
    browserHtmlFetcher = fetcher || fetchPageHtmlWithBrowser;
}

export async function tryRequestWithBrowserCookies(
    url: string,
    signal?: AbortSignal
): Promise<{ response?: AxiosResponse; usedBrowserCookies: boolean }> {
    let cookieHeader: string | undefined;
    try {
        cookieHeader = await browserCookieHeaderGetter(url, false, signal);
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        return { response: undefined, usedBrowserCookies: false };
    }

    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', message: 'Request aborted', retryable: false });
    }
    if (!cookieHeader) {
        return { response: undefined, usedBrowserCookies: false };
    }

    try {
        return {
            response: await requestWithSafeRedirects('GET', url, buildRequestOptions(cookieHeader, false, signal), 'Request URL'),
            usedBrowserCookies: true
        };
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        return {
            response: undefined,
            usedBrowserCookies: true
        };
    }
}

/**
 * 浏览器兜底（cookie 采集 + HTML 渲染）的分段独立懒启动预算。
 *
 * 架构分工（分段独立预算 + 进入阶段时才开始计时）：
 * 1. 预算计时器在首次进入对应阶段（withinBudget 调用）时才启动，前置的 HEAD / GET 请求耗时不会侵占浏览器阶段预算。
 * 2. withinBudget 接收惰性任务工厂 `(signal) => Promise<T>`：预算已耗尽时不启动新任务；阶段超时时通过 AbortSignal 主动中止底层请求与页面。
 */
export function createBrowserBudget(label: string, budgetMs = FETCH_WEB_BROWSER_BUDGET_MS, parentSignal?: AbortSignal) {
    let deadline: number | null = null;
    let exhausted = false;
    return function withinBudget<T>(task: (signal: AbortSignal) => Promise<T>, step: string): Promise<T> {
        if (parentSignal?.aborted) {
            return Promise.reject(
                parentSignal.reason instanceof Error
                    ? parentSignal.reason
                    : new AppError({
                        code: 'aborted',
                        retryable: false,
                        message: `${label} aborted before ${step}`
                    })
            );
        }
        if (deadline === null) {
            deadline = Date.now() + budgetMs;
        }
        const remaining = deadline - Date.now();
        if (exhausted || remaining <= 0) {
            exhausted = true;
            return Promise.reject(new AppError({
                code: 'network_timeout',
                retryable: true,
                message: `${label} browser fallback budget (${budgetMs}ms) exhausted before ${step}`
            }));
        }
        const controller = new AbortController();
        const onParentAbort = () => {
            controller.abort(
                parentSignal?.reason ?? new AppError({
                    code: 'aborted',
                    retryable: false,
                    message: `${label} aborted during ${step}`
                })
            );
        };
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                exhausted = true;
                const timeoutError = new AppError({
                    code: 'network_timeout',
                    retryable: true,
                    message: `${label} browser fallback budget (${budgetMs}ms) exceeded during ${step}`
                });
                controller.abort(timeoutError);
                reject(timeoutError);
            }, remaining);
            if (typeof timer === 'object' && typeof timer.unref === 'function') {
                timer.unref();
            }
            Promise.resolve()
                .then(() => task(controller.signal))
                .then(
                    (value) => {
                        clearTimeout(timer);
                        parentSignal?.removeEventListener('abort', onParentAbort);
                        resolve(value);
                    },
                    (error) => {
                        clearTimeout(timer);
                        parentSignal?.removeEventListener('abort', onParentAbort);
                        reject(error);
                    }
                );
        });
    };
}
