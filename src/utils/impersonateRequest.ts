import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { loadWreqModule, createWreqSession, WreqSession } from '../engines/bing/impersonate.js';
import { toAxiosLikeResponse } from './wreqRequest.js';
import { isTlsOrWafResetError } from './domesticDirectNetwork.js';
import { AppError, isAbortedError, isCascadeAbortedError } from '../core/errors.js';
import { metrics } from '../core/metrics.js';

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

/**
 * 供单元测试注入或清理会话
 */
export function __setEngineSessionForTests(engine: string, session: WreqSession | null): void {
    if (session === null) {
        engineSessions.delete(engine);
    } else {
        engineSessions.set(engine, Promise.resolve(session));
    }
}

export type ImpersonateHttpOptions = {
    redirect?: 'manual' | 'follow';
    failOnHttpError?: boolean;
};

function createImpersonateAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new AppError({ code: 'aborted', retryable: false, message: 'Impersonate request aborted' });
}

function raceWithSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    if (!signal) {
        return fn();
    }
    if (signal.aborted) {
        return Promise.reject(createImpersonateAbortError(signal));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(createImpersonateAbortError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        fn().then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (err) => {
                signal.removeEventListener('abort', onAbort);
                reject(err);
            }
        );
    });
}

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
    const signal = options.signal as AbortSignal | undefined;
    if (signal?.aborted) {
        throw createImpersonateAbortError(signal);
    }

    try {
        const session = await raceWithSignal(signal, () => getOrCreateWreqSession(engine));
        if (session) {
            const timeout = typeof options.timeout === 'number' ? options.timeout : 15000;
            const headers = options.headers as Record<string, string> | undefined;
            const fetchOptions = {
                timeout,
                headers,
                redirect: impersonateOptions?.redirect,
                ...(signal ? { signal } : {})
            };

            const retryMaxCount = 1;
            const retryDelayMs = 100;

            let response: Awaited<ReturnType<typeof session.fetch>> | undefined;
            try {
                response = await raceWithSignal(signal, () => session.fetch(url, fetchOptions));
            } catch (firstError) {
                if (signal?.aborted) {
                    throw firstError;
                }
                // 首连遭遇 TLS 握手断开、WAF 首连捏断（如 unexpected EOF、ECONNRESET、socket hang up）时，
                // 底层连接池会丢弃坏连接。原地静默快速重试，避免过早陷入耗时的 axios 失败链与二次回退
                if (isTlsOrWafResetError(firstError) && retryMaxCount > 0) {
                    let lastRetryErr: unknown = firstError;
                    for (let r = 0; r < retryMaxCount; r += 1) {
                        await raceWithSignal(signal, () => new Promise((resolve) => setTimeout(resolve, retryDelayMs)));
                        try {
                            response = await raceWithSignal(signal, () => session.fetch(url, fetchOptions));
                            lastRetryErr = null;
                            break;
                        } catch (retryError) {
                            lastRetryErr = retryError;
                            if (signal?.aborted) {
                                break;
                            }
                        }
                    }
                    if (lastRetryErr) {
                        invalidateWreqSession(engine);
                        throw lastRetryErr;
                    }
                } else {
                    throw firstError;
                }
            }

            if (!response) {
                throw new AppError({
                    code: 'upstream_response_invalid',
                    retryable: true,
                    engine,
                    message: `[${engine}] Failed to obtain response from impersonate session`
                });
            }

            if (impersonateOptions?.failOnHttpError !== false && response.status >= 400) {
                const status = response.status;
                throw new AppError({
                    code: status === 429 ? 'rate_limited' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'network_error',
                    retryable: status === 429 || status >= 500,
                    status,
                    engine,
                    message: `Request failed with status code ${status}`
                });
            }

            const resolvedResponse = response;
            const body = await raceWithSignal<string>(signal, () => resolvedResponse.text());
            return toAxiosLikeResponse(resolvedResponse.status, resolvedResponse.headers, body, options);
        }
    } catch (error) {
        if (isAbortedError(error, signal)) {
            if (isCascadeAbortedError(error, signal)) {
                metrics.debug(`[${engine}] impersonate request cancelled (cascade_aborted)`);
            }
            throw error;
        }
        // HTTP 业务状态错误（例如 429 限流）直接抛出，不进行无意义的 client 回退
        if (typeof error === 'object' && error !== null && (('response' in error && typeof (error as { response: unknown }).response === 'object' && (error as { response: unknown }).response !== null && 'status' in ((error as { response: Record<string, unknown> }).response)) || ('status' in error && typeof (error as { status: unknown }).status === 'number'))) {
            throw error;
        }
        console.warn(
            `[${engine}] impersonate request failed, falling back to axios:`,
            error instanceof Error ? error.message : String(error)
        );
    }

    if (signal?.aborted) {
        throw createImpersonateAbortError(signal);
    }

    return axios.get(url, options);
}

