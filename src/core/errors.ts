/**
 * 统一错误码枚举。
 * CLI 和 Daemon 层共享同一套错误码，避免命名不一致（如 CLI 用 invalid_arguments，
 * Daemon 用 invalid_request）。
 */
export const ErrorCode = {
    /** 参数校验失败（CLI 和 Daemon 共用） */
    INVALID_ARGUMENTS: 'invalid_arguments',
    /** 资源未找到 */
    NOT_FOUND: 'not_found',
    /** 搜索引擎错误 */
    ENGINE_ERROR: 'engine_error',
    /** Daemon 不可达 */
    DAEMON_UNAVAILABLE: 'daemon_unavailable',
    /** Daemon 请求超时 */
    DAEMON_TIMEOUT: 'daemon_timeout',
    /** Daemon 请求失败 */
    DAEMON_REQUEST_FAILED: 'daemon_request_failed',
    /** 请求体过大 */
    PAYLOAD_TOO_LARGE: 'payload_too_large',
    /** 上游错误 */
    UPSTREAM_ERROR: 'upstream_error',
    /** HTTP 错误 */
    HTTP_ERROR: 'http_error',
    /** 网络错误 */
    NETWORK_ERROR: 'network_error',
    /** 内容提取失败 */
    EXTRACTION_FAILED: 'extraction_failed'
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

import axios from 'axios';

export type RetryableError = Error & {
    retryable?: boolean;
    code?: string;
    status?: number;
};

/**
 * 将 Error 实例标记为不可重试（retryable = false），供多引擎协调与重试机制识别
 */
export function markNonRetryable<T extends Error>(error: T): T & { retryable: false } {
    return Object.assign(error, { retryable: false as const });
}

/**
 * 检查错误是否被显式标记为不可重试
 */
export function isExplicitNonRetryable(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'retryable' in error) {
        return (error as { retryable: unknown }).retryable === false;
    }
    return false;
}

/**
 * 类型安全地提取 HTTP 状态码（支持 AxiosError、带 status 字段的对象等）
 */
export function extractErrorStatus(error: unknown): number | undefined {
    if (axios.isAxiosError(error)) {
        return error.response?.status;
    }
    if (typeof error === 'object' && error !== null) {
        if ('status' in error && typeof (error as { status: unknown }).status === 'number') {
            return (error as { status: number }).status;
        }
        if ('response' in error) {
            const resp = (error as { response: unknown }).response;
            if (typeof resp === 'object' && resp !== null && 'status' in resp && typeof (resp as { status: unknown }).status === 'number') {
                return (resp as { status: number }).status;
            }
        }
    }
    return undefined;
}

/**
 * 类型安全地提取错误代码（如 ERR_NETWORK、ECONNRESET 等）
 */
export function extractErrorCode(error: unknown): string | undefined {
    if (axios.isAxiosError(error)) {
        return error.code;
    }
    if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
        return (error as { code: string }).code;
    }
    return undefined;
}
