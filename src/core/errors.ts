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
    EXTRACTION_FAILED: 'extraction_failed',
    /** 频率限制 / 配额耗尽 */
    RATE_LIMITED: 'rate_limited'
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

import axios from 'axios';

export type PublicErrorCode =
    | 'missing_api_key'
    | 'missing_optional_dependency'
    | 'invalid_config'
    | 'invalid_arguments'
    | 'unsupported_engine'
    | 'bot_challenge'
    | 'rate_limited'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'proxy_unreachable'
    | 'overseas_unreachable'
    | 'network_timeout'
    | 'engine_timeout'
    | 'network_error'
    | 'aborted'
    | 'queue_full'
    | 'engine_parse_error'
    | 'empty_content'
    | 'upstream_response_invalid'
    | 'redirect_not_allowed'
    | 'response_too_large'
    | 'start_index_out_of_range'
    | 'pdf_no_text_layer'
    | 'pdf_parse_error'
    | 'engine_error';

export type AppErrorCode = PublicErrorCode;

export type LegacyAppErrorCode =
    | 'ERR_BOT_CHALLENGE'
    | 'ERR_RESPONSE_TOO_LARGE'
    | 'ERR_START_INDEX_OUT_OF_RANGE'
    | 'cascade_aborted';

const RAW_TO_PUBLIC_CODE_MAP: Record<string, PublicErrorCode> = {
    ERR_BOT_CHALLENGE: 'bot_challenge',
    ERR_RESPONSE_TOO_LARGE: 'response_too_large',
    ERR_START_INDEX_OUT_OF_RANGE: 'start_index_out_of_range',
    pdf_no_text_layer: 'pdf_no_text_layer',
    pdf_parse_error: 'pdf_parse_error',
    engine_timeout: 'network_timeout',
    ETIMEDOUT: 'network_timeout',
    ECONNABORTED: 'network_timeout',
    ERR_NETWORK: 'network_error',
    ECONNRESET: 'network_error',
    ECONNREFUSED: 'network_error',
    EAI_AGAIN: 'network_error',
    ENOTFOUND: 'network_error',
    EPIPE: 'network_error',
    ERR_SOCKET_CONNECTION_TIMEOUT: 'network_timeout',
    UND_ERR_SOCKET: 'network_error',
    ERR_CANCELED: 'aborted',
    ABORT_ERR: 'aborted',
    cascade_aborted: 'aborted'
};

const PUBLIC_ERROR_CODE_SET = new Set<PublicErrorCode>([
    'missing_api_key',
    'missing_optional_dependency',
    'invalid_config',
    'invalid_arguments',
    'unsupported_engine',
    'bot_challenge',
    'rate_limited',
    'unauthorized',
    'forbidden',
    'not_found',
    'proxy_unreachable',
    'overseas_unreachable',
    'network_timeout',
    'engine_timeout',
    'network_error',
    'aborted',
    'queue_full',
    'engine_parse_error',
    'empty_content',
    'upstream_response_invalid',
    'redirect_not_allowed',
    'response_too_large',
    'start_index_out_of_range',
    'engine_error'
]);

export function normalizePublicErrorCode(code: string | undefined): PublicErrorCode | undefined {
    if (!code) {
        return undefined;
    }
    const mapped = RAW_TO_PUBLIC_CODE_MAP[code];
    if (mapped) {
        return mapped;
    }
    if (PUBLIC_ERROR_CODE_SET.has(code as PublicErrorCode)) {
        return code as PublicErrorCode;
    }
    return undefined;
}

export interface AppErrorOptions {
    code: AppErrorCode | LegacyAppErrorCode;
    message?: string;
    retryable: boolean;
    status?: number;
    hint?: string;
    engine?: string;
    details?: Record<string, unknown>;
    cause?: unknown;
}

/**
 * 结构化应用错误，供 CLI、MCP、daemon、doctor 与搜索引擎编排层共享一致的错误语义，
 * 避免依赖脆弱的自然语言正则匹配。底层错误保存在 cause 或 details 中。
 */
export class AppError extends Error {
    readonly code: AppErrorCode;
    readonly retryable: boolean;
    readonly status?: number;
    readonly hint?: string;
    readonly engine?: string;
    readonly details?: Record<string, unknown>;

    constructor(options: AppErrorOptions) {
        const normalizedCode = (RAW_TO_PUBLIC_CODE_MAP[options.code] ?? options.code) as AppErrorCode;
        const defaultMessage = options.message
            ?? (options.hint ? `${normalizedCode}: ${options.hint}` : normalizedCode);
        super(defaultMessage, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'AppError';
        this.code = normalizedCode;
        this.retryable = options.retryable;
        if (options.status !== undefined) {
            this.status = options.status;
        }
        if (options.hint !== undefined) {
            this.hint = options.hint;
        }
        if (options.engine !== undefined) {
            this.engine = options.engine;
        }
        const legacyCode = typeof options.details?.legacyCode === 'string'
            ? options.details.legacyCode
            : (options.code !== normalizedCode ? options.code : undefined);
        const mergedDetails: Record<string, unknown> = {
            ...(options.details ?? {}),
            ...(legacyCode ? { legacyCode, rawCode: options.details?.rawCode ?? legacyCode } : {})
        };
        if (Object.keys(mergedDetails).length > 0) {
            this.details = mergedDetails;
        }
    }
}

export function isAppError(error: unknown): error is AppError {
    return error instanceof AppError || (
        typeof error === 'object'
        && error !== null
        && (error as { name?: unknown }).name === 'AppError'
        && typeof (error as { code?: unknown }).code === 'string'
        && typeof (error as { retryable?: unknown }).retryable === 'boolean'
    );
}

export type RetryableError = Error & {
    retryable?: boolean;
    code?: string;
    status?: number;
    hint?: string;
    details?: Record<string, unknown>;
};

const NON_RETRYABLE_ERROR_CODES = new Set<string>([
    'missing_api_key',
    'missing_optional_dependency',
    'invalid_config',
    'invalid_arguments',
    'unsupported_engine',
    'bot_challenge',
    'ERR_BOT_CHALLENGE',
    'response_too_large',
    'ERR_RESPONSE_TOO_LARGE',
    'start_index_out_of_range',
    'ERR_START_INDEX_OUT_OF_RANGE',
    'engine_parse_error',
    'empty_content',
    'upstream_response_invalid',
    'redirect_not_allowed',
    'unauthorized',
    'forbidden',
    'not_found',
    'overseas_unreachable',
    'aborted',
    'cascade_aborted',
    'ERR_CANCELED',
    'ABORT_ERR'
]);

/**
 * 判断错误或信号是否由级联同批达标主动取消（cascade_aborted 哨兵码）触发，
 * 供底层请求层（wreq/axios/引擎）识别并将取消日志降级为 debug，避免误报"请求失败并回退 axios"。
 */
export function isCascadeAbortedError(error: unknown, signal?: AbortSignal): boolean {
    const candidates = [error, signal?.reason];
    for (const candidate of candidates) {
        if (isAppError(candidate)) {
            if (candidate.details?.rawCode === 'cascade_aborted' || candidate.details?.legacyCode === 'cascade_aborted') {
                return true;
            }
        }
        if (typeof candidate === 'object' && candidate !== null && (candidate as { code?: unknown }).code === 'cascade_aborted') {
            return true;
        }
    }
    return false;
}

/**
 * 判断错误或 AbortSignal 是否属于主动取消（含用户取消、级联同批达标取消、Axios ERR_CANCELED）
 */
export function isAbortedError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted || isCascadeAbortedError(error, signal)) {
        return true;
    }
    if (isAppError(error) && error.code === 'aborted') {
        return true;
    }
    if (typeof error === 'object' && error !== null) {
        const rawCode = (error as { code?: unknown }).code;
        if (rawCode === 'aborted' || rawCode === 'cascade_aborted' || rawCode === 'ERR_CANCELED' || rawCode === 'ABORT_ERR') {
            return true;
        }
    }
    return false;
}

const RETRYABLE_ERROR_CODES = new Set<string>([
    'rate_limited',
    'network_timeout',
    'engine_timeout',
    'network_error',
    'proxy_unreachable',
    'queue_full',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE'
]);

/**
 * 将 Error 实例标记为不可重试（retryable = false），供多引擎协调与重试机制识别
 */
export function markNonRetryable<T extends Error>(error: T, code?: AppErrorCode): T & { retryable: false } {
    if (code && !('code' in error)) {
        Object.assign(error, { code: normalizePublicErrorCode(code) ?? code });
    }
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
 * 类型安全地提取 HTTP 状态码（支持 AppError、AxiosError、带 status 字段的对象等）
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
 * 提取原始底层错误码（如 ETIMEDOUT、ECONNRESET、ERR_BOT_CHALLENGE 等）
 */
export function extractRawErrorCode(error: unknown): string | undefined {
    if (isAppError(error)) {
        const raw = error.details?.rawCode;
        return typeof raw === 'string' ? raw : error.code;
    }
    if (axios.isAxiosError(error)) {
        return error.code;
    }
    if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
        return (error as { code: string }).code;
    }
    const message = error instanceof Error ? error.message : (typeof error === 'string' ? error : '');
    if (/socket hang up/i.test(message)) {
        return 'ECONNRESET';
    }
    return undefined;
}

/**
 * 类型安全地提取统一公共错误代码（底层 Node/Axios 错误码自动归一到 network_timeout / network_error 等公共码）
 */
export function extractErrorCode(error: unknown): string | undefined {
    const raw = extractRawErrorCode(error);
    if (!raw) {
        return undefined;
    }
    if (isAppError(error)) {
        return normalizePublicErrorCode(error.code) ?? error.code;
    }
    return normalizePublicErrorCode(raw) ?? raw;
}

/**
 * 提取结构化 details（若底层错误码被归一为公共错误码，自动将底层原始码收入 details.rawCode）
 */
export function extractErrorDetails(error: unknown): Record<string, unknown> | undefined {
    const baseDetails = (typeof error === 'object' && error !== null && 'details' in error && typeof (error as { details: unknown }).details === 'object' && (error as { details: unknown }).details !== null)
        ? { ...((error as { details: Record<string, unknown> }).details) }
        : {};
    const rawCode = extractRawErrorCode(error);
    const publicCode = extractErrorCode(error);
    if (rawCode && publicCode && rawCode !== publicCode && baseDetails.rawCode === undefined) {
        baseDetails.rawCode = rawCode;
    }
    return Object.keys(baseDetails).length > 0 ? baseDetails : undefined;
}

export function extractErrorHint(error: unknown): string | undefined {
    if (isAppError(error)) {
        return error.hint;
    }
    if (typeof error === 'object' && error !== null && 'hint' in error && typeof (error as { hint: unknown }).hint === 'string') {
        return (error as { hint: string }).hint;
    }
    return undefined;
}

// ---- 错误分类可观测性统计（衡量结构化 AppError 覆盖率 vs 兼容层字符串 fallback 命中率） ----
let structuredErrorCount = 0;
let legacyErrorFallbackCount = 0;
let legacyFallbackHitCount = 0;
const recentFallbackSamples: string[] = [];
const MAX_FALLBACK_SAMPLES = 20;

function recordStructuredClassification(): void {
    structuredErrorCount += 1;
}

function recordLegacyFallbackClassification(message: string, matched: boolean): void {
    legacyErrorFallbackCount += 1;
    if (matched) {
        legacyFallbackHitCount += 1;
        const sample = message.replace(/\s+/g, ' ').trim().slice(0, 120);
        if (sample && !recentFallbackSamples.includes(sample)) {
            if (recentFallbackSamples.length >= MAX_FALLBACK_SAMPLES) {
                recentFallbackSamples.shift();
            }
            recentFallbackSamples.push(sample);
        }
        const isDebug = (process.env.LOG_LEVEL ?? '').toLowerCase() === 'debug'
            || process.env.DEBUG_TEST_LOGS === 'true';
        if (isDebug) {
            console.error(`[errors/fallback] Legacy string fallback matched unstructured error: ${sample}`);
        }
    }
}

export interface ErrorClassificationMetrics {
    totalClassified: number;
    structuredErrorCount: number;
    legacyErrorFallbackCount: number;
    legacyFallbackHitCount: number;
    structured_error_rate: number;
    legacy_error_fallback_rate: number;
    recentFallbackSamples: string[];
}

export function getErrorClassificationMetrics(): ErrorClassificationMetrics {
    const total = structuredErrorCount + legacyErrorFallbackCount;
    return {
        totalClassified: total,
        structuredErrorCount,
        legacyErrorFallbackCount,
        legacyFallbackHitCount,
        structured_error_rate: total > 0 ? Number((structuredErrorCount / total).toFixed(4)) : 1,
        legacy_error_fallback_rate: total > 0 ? Number((legacyErrorFallbackCount / total).toFixed(4)) : 0,
        recentFallbackSamples: [...recentFallbackSamples]
    };
}

export function resetErrorClassificationMetrics(): void {
    structuredErrorCount = 0;
    legacyErrorFallbackCount = 0;
    legacyFallbackHitCount = 0;
    recentFallbackSamples.length = 0;
}

/**
 * 仅作为未结构化旧错误/测试桩 Error 的最小兼容 fallback。
 * 所有内置引擎与核心模块均已抛出结构化 AppError（code + retryable），
 * 此处严禁包含 forbidden、unauthorized、captcha、anti-bot 等可能在正常业务文本中出现的宽泛词汇。
 */
export function isNonRetryableErrorMessage(message: string): boolean {
    if (!message) {
        return false;
    }
    return /(?:returned a (?:challenge|verification) page|anti-bot (?:challenge|verification) page|verification page blocked|captcha challenge page|ERR_BOT_CHALLENGE|EXA_API_KEY is required|requires [A-Z0-9_]+ to be configured|SEARCH_MODE disables Playwright|Must be a valid HTTP|Blocked non-public|private or local network)/i.test(message);
}

/**
 * 统一判断引擎/网络错误是否可重试：
 * 1. 优先读取结构化 AppError 或显式 retryable 布尔字段
 * 2. 其次按结构化错误码（code）判定
 * 3. 有明确 HTTP 状态码时，仅 429 和 5xx 可重试（400/401/403/404 等不可重试）
 * 4. 兜底匹配非结构化 Error 消息（记录 legacy_error_fallback_rate 指标与 debug 日志）
 */
export function isRetryableError(error: unknown): boolean {
    if (isAppError(error)) {
        recordStructuredClassification();
        return error.retryable;
    }
    if (typeof error === 'object' && error !== null && 'retryable' in error && typeof (error as { retryable: unknown }).retryable === 'boolean') {
        recordStructuredClassification();
        return (error as { retryable: boolean }).retryable;
    }
    const rawCode = extractRawErrorCode(error);
    const publicCode = extractErrorCode(error);
    for (const candidateCode of [publicCode, rawCode]) {
        if (!candidateCode) {
            continue;
        }
        if (NON_RETRYABLE_ERROR_CODES.has(candidateCode)) {
            recordStructuredClassification();
            return false;
        }
        if (RETRYABLE_ERROR_CODES.has(candidateCode)) {
            recordStructuredClassification();
            return true;
        }
    }
    const status = extractErrorStatus(error);
    if (typeof status === 'number') {
        recordStructuredClassification();
        return status === 429 || status >= 500;
    }
    const message = error instanceof Error ? error.message : String(error);
    const matchedNonRetryable = isNonRetryableErrorMessage(message);
    recordLegacyFallbackClassification(message, matchedNonRetryable);
    return !matchedNonRetryable;
}

/**
 * 判断 SearchExecutionFailure 是否可重试（优先读取显式记录的 failure.retryable 与 errorCode）
 */
export function classifyFailureRetryable(failure: {
    code: string;
    errorCode?: string;
    message: string;
    retryable?: boolean;
}): boolean {
    if (typeof failure.retryable === 'boolean') {
        recordStructuredClassification();
        return failure.retryable;
    }
    if (failure.errorCode) {
        const normalized = normalizePublicErrorCode(failure.errorCode) ?? failure.errorCode;
        if (NON_RETRYABLE_ERROR_CODES.has(normalized) || NON_RETRYABLE_ERROR_CODES.has(failure.errorCode)) {
            recordStructuredClassification();
            return false;
        }
        if (RETRYABLE_ERROR_CODES.has(normalized) || RETRYABLE_ERROR_CODES.has(failure.errorCode)) {
            recordStructuredClassification();
            return true;
        }
    }
    if (failure.code === 'unsupported_engine' || failure.code === 'no_results') {
        recordStructuredClassification();
        return false;
    }
    if (failure.code === 'circuit_open') {
        recordStructuredClassification();
        return true;
    }
    if (/socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(failure.message)) {
        recordStructuredClassification();
        return true;
    }
    const matchedNonRetryable = isNonRetryableErrorMessage(failure.message);
    recordLegacyFallbackClassification(failure.message, matchedNonRetryable);
    return !matchedNonRetryable;
}


