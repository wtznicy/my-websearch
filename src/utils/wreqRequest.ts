import type { AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * wreq-js 响应的 axios 形状适配。
 *
 * 多个引擎的请求层需要"指纹优先 + axios 回退"（bing 用 wreq 原生 API，
 * sogou/brave 等保留现有的 axios 风格处理逻辑如重定向跟随/解析），
 * 这里集中把 wreq 的 fetch 响应转成现有代码能直接读的 axios 形状。
 */

export type WreqLikeHeaders = {
    get(name: string): string | null;
    forEach?(callback: (value: string, key: string) => void): void;
    getSetCookie?(): string[];
};

export function toAxiosLikeResponse(
    status: number,
    headers: WreqLikeHeaders,
    data: string,
    options: AxiosRequestConfig
): AxiosResponse {
    const normalizedHeaders: Record<string, string | string[]> = {};
    headers.forEach?.((value, key) => {
        normalizedHeaders[key.toLowerCase()] = value;
    });
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    if (setCookies.length > 0) {
        normalizedHeaders['set-cookie'] = setCookies;
    }
    return {
        status,
        statusText: '',
        headers: normalizedHeaders,
        data,
        config: options,
        request: {}
    } as unknown as AxiosResponse;
}
