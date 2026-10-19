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
};

export type SearchEngineExecutor = (query: string, limit: number, context?: SearchExecutionContext) => Promise<SearchResult[]>;
export type SearchEngineExecutorMap = Partial<Record<string, SearchEngineExecutor>>;

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
