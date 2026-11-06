import type { AppConfig } from '../../config.js';
import type { SearchResult } from '../../types.js';
import type { TimeRange } from '../../utils/dateNormalizer.js';
import type { RequestContext } from '../requestContext.js';

/** 单引擎执行上下文（从 searchService 抽出，避免 engineExecutor ↔ searchService 运行时环） */
export type SearchExecutionContext = {
    searchMode?: AppConfig['searchMode'];
    signal?: AbortSignal;
    timeRange?: TimeRange;
    site?: string[];
    requestContext?: RequestContext;
    /** 是否属于多引擎并发/级联补位场景（用于引擎内部调整 PoW 难度预算与快速失败策略） */
    isMultiEngine?: boolean;
};

export type SearchEngineExecutor = (query: string, limit: number, context?: SearchExecutionContext) => Promise<SearchResult[]>;
export type SearchEngineExecutorMap = Partial<Record<string, SearchEngineExecutor>>;

/**
 * 单引擎基础超时：固定值，或按引擎取值（优先用 registry 的 defaultTimeoutMs）。
 * 浏览器兜底类引擎（brave/startpage/bing）在 executor 内还会叠加 1.5x–2x 预算。
 */
export type PerEngineTimeoutMs = number | ((engine: string) => number);

export function resolvePerEngineTimeoutMs(value: PerEngineTimeoutMs, engine: string): number {
    return typeof value === 'function' ? value(engine) : value;
}

export type SearchExecutionFailure = {
    engine: string;
    code: 'engine_error' | 'unsupported_engine' | 'no_results' | 'circuit_open';
    errorCode?: string;
    status?: number;
    hint?: string;
    details?: Record<string, unknown>;
    message: string;
    retryable?: boolean;
};
