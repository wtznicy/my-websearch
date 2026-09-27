import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { loadWreqModule, createWreqSession, WreqSession } from '../engines/bing/impersonate.js';
import { toAxiosLikeResponse } from './wreqRequest.js';

const engineSessions = new Map<string, Promise<WreqSession | null>>();

/**
 * 获取或懒加载指定引擎的 wreq-js 会话（每个引擎独立维护会话与连接池）
 */
export async function getOrCreateWreqSession(engine: string): Promise<WreqSession | null> {
    let sessionPromise = engineSessions.get(engine);
    if (!sessionPromise) {
        sessionPromise = (async () => {
            const mod = await loadWreqModule();
            if (!mod) {
                return null;
            }
            try {
                return await createWreqSession(mod, engine);
            } catch (error) {
                console.warn(
                    `[${engine}] wreq session creation failed, falling back to axios:`,
                    error instanceof Error ? error.message : String(error)
                );
                return null;
            }
        })();
        engineSessions.set(engine, sessionPromise);
    }
    return sessionPromise;
}

/**
 * 销毁并重置指定引擎的会话（当遇到网络层断开、TLS RST 或会话损坏时调用）
 */
export function invalidateWreqSession(engine: string): void {
    const sessionPromise = engineSessions.get(engine);
    engineSessions.delete(engine);
    if (sessionPromise) {
        sessionPromise.then((session) => {
            if (session) {
                session.close().catch(() => undefined);
            }
        }).catch(() => undefined);
    }
}

export type ImpersonateHttpOptions = {
    redirect?: 'manual' | 'follow';
    failOnHttpError?: boolean;
};

/**
 * 统一的浏览器指纹优先 GET 请求：
 * 优先使用 wreq-js（Rust Chrome TLS/HTTP2 指纹）发起请求；
 * 当 wreq 不可用或发生非 HTTP 状态异常时，自动安全回退至 axios。
 */
export async function impersonateHttpGet(
    engine: string,
    url: string,
    options: AxiosRequestConfig,
    impersonateOptions?: ImpersonateHttpOptions
): Promise<AxiosResponse> {
    try {
        const session = await getOrCreateWreqSession(engine);
        if (session) {
            const timeout = typeof options.timeout === 'number' ? options.timeout : 15000;
            const headers = options.headers as Record<string, string> | undefined;

            const response = await session.fetch(url, {
                timeout,
                headers,
                redirect: impersonateOptions?.redirect
            });

            if (impersonateOptions?.failOnHttpError !== false && response.status >= 400) {
                const error = new Error(`Request failed with status code ${response.status}`);
                Object.assign(error, { response: { status: response.status } });
                throw error;
            }

            const body = await response.text();
            return toAxiosLikeResponse(response.status, response.headers, body, options);
        }
    } catch (error) {
        // HTTP 业务状态错误（例如 429 限流）直接抛出，不进行无意义的 client 回退
        if (typeof error === 'object' && error !== null && 'response' in error) {
            const resp = (error as { response: unknown }).response;
            if (typeof resp === 'object' && resp !== null && 'status' in resp) {
                throw error;
            }
        }
        console.warn(
            `[${engine}] impersonate request failed, falling back to axios:`,
            error instanceof Error ? error.message : String(error)
        );
    }

    return axios.get(url, options);
}
