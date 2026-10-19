import { AppError } from '../../core/errors.js';

// Types & Errors
import {
    DEFAULT_MAX_CHARS,
    ExtractedLink,
    FETCH_WEB_TOTAL_BUDGET_MS,
    FetchWebContentOptions,
    FetchWebContentResult,
    JsdomUnavailableError
} from './types.js';

// Transport helpers for testing & backward compatibility
import {
    createBrowserBudget,
    __setBrowserCookieHeaderForTests,
    __setBrowserHtmlFetcherForTests
} from './transport.js';

// Extraction helpers for testing & backward compatibility
import {
    detectLlmMarkdownUrl,
    __setReadabilityParserForTests
} from './extraction.js';

// Pagination
import { generateMarkdownToc } from './pagination.js';

// Pipeline Stages
import {
    validateAndFetchPrimary,
    tryHandlePdfFetch,
    fetchAndExtractHtmlWithBrowserFallback,
    validateFetchOutcome,
    assembleFetchResult
} from './stages.js';

// Public re-exports for backward compatibility
export {
    createBrowserBudget,
    detectLlmMarkdownUrl,
    FETCH_WEB_TOTAL_BUDGET_MS,
    generateMarkdownToc,
    JsdomUnavailableError,
    __setBrowserCookieHeaderForTests,
    __setBrowserHtmlFetcherForTests,
    __setReadabilityParserForTests
};

export type {
    ExtractedLink,
    FetchWebContentOptions,
    FetchWebContentResult
};

/**
 * 网页内容抓取与提取主入口。
 * 编排五大阶段：校验与主请求 → PDF 处理 → HTML/浏览器提取 → 门禁与回退校验 → 响应组装。
 */
export async function fetchWebContent(
    url: string,
    maxChars: number = DEFAULT_MAX_CHARS,
    options: FetchWebContentOptions = {}
): Promise<FetchWebContentResult> {
    const callerSignal = options.signal;
    if (callerSignal?.aborted) {
        throw callerSignal.reason instanceof Error
            ? callerSignal.reason
            : new AppError({ code: 'aborted', message: 'fetchWebContent aborted', retryable: false });
    }

    const abortController = new AbortController();
    const totalTimer = setTimeout(() => {
        abortController.abort(new AppError({
            code: 'network_timeout',
            retryable: true,
            message: `fetchWebContent exceeded overall execution budget (${FETCH_WEB_TOTAL_BUDGET_MS}ms)`
        }));
    }, FETCH_WEB_TOTAL_BUDGET_MS);

    const onCallerAbort = () => {
        abortController.abort(callerSignal?.reason);
    };
    if (callerSignal) {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const signal = abortController.signal;
    try {
        // 1. 校验与初始抓取 (URL 安全检查、HEAD 预检、GET 主请求与 Cookie 自动重试)
        const primary = await validateAndFetchPrimary(url, maxChars, options, signal);

        // 2. PDF 处理 (自动检测 PDF 响应、分页切片并返回)
        const pdfResult = await tryHandlePdfFetch(primary, options);
        if (pdfResult) {
            return pdfResult;
        }

        // 3. HTML / 浏览器阶段 (LLM Markdown、无头浏览器兜底、站点提纯与 Readability 提取)
        const htmlStage = await fetchAndExtractHtmlWithBrowserFallback(primary, options, signal);

        // 4. 回退与门禁校验 (反爬拦截判定、Soft 404 检测、空正文兜底)
        validateFetchOutcome(primary, htmlStage, options);

        // 5. 响应组装 (正文分页/聚焦切片、TOC 生成与结果信封组装)
        return assembleFetchResult(primary, htmlStage, options);
    } finally {
        clearTimeout(totalTimer);
        if (callerSignal) {
            callerSignal.removeEventListener('abort', onCallerAbort);
        }
    }
}
