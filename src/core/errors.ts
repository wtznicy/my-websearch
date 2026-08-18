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
