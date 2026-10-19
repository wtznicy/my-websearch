import { AppError } from '../../core/errors.js';

export interface FetchWebContentResult {
    url: string;
    finalUrl: string;
    contentType: string;
    title: string;
    retrievalMethod: 'request' | 'request-with-browser-cookies' | 'browser-html';
    truncated: boolean;
    content: string;
    /** Raw response body (HTML/plain text) as received, before any extraction. */
    raw?: string;
    /** Total length of the extracted (or raw) content before paging. */
    totalLength: number;
    /** Starting character offset of this page (echo of the request). */
    startIndex: number;
    /** Whether more content remains beyond this page (call with nextStartIndex to continue). */
    hasMore?: boolean;
    /** Offset to pass as startIndex on the next call to continue reading. */
    nextStartIndex?: number;
    readabilityApplied?: boolean;
    /** 请求了 readability 但降级为普通提取时的原因（显式告知调用方，避免静默降级） */
    degraded?: string[];
    readableHtml?: string;
    links?: ExtractedLink[];
    byline?: string;
    excerpt?: string;
    siteName?: string;
    /** 当提取的 Markdown 发生截断（truncated: true）时扫描生成的目录索引，如 ["# Intro (0)", "## Auth (34200)"] */
    toc?: string[];
    /** 是否命中 focus 关键词靶向抓取 */
    focused?: boolean;
    focusMatchOffset?: number;
    cached?: boolean;
    warnings?: string[];
    pdfPages?: number;
    format?: 'markdown';
}

export type ExtractedLink = {
    text: string;
    href: string;
};

export type FetchWebContentOptions = {
    readability?: boolean;
    includeLinks?: boolean;
    /** Return the raw response body (HTML/plain text) without extraction. */
    raw?: boolean;
    /** Start reading at this character offset (for paging through long content). */
    startIndex?: number;
    /** Include the full Readability DOM HTML in the response (default off — it can be tens of KB of tokens). */
    includeReadableHtml?: boolean;
    /**
     * 正文输出格式（默认 text）。'markdown' 时用 turndown 把 Readability 抽取的 DOM
     * 转为 Markdown——保留围栏代码块语言与 GFM 表格，更适合技术文档与 LLM。
     */
    format?: 'text' | 'markdown';
    /** 章节靶向关键词：在全文中定位该词并返回前后上下文（前后各约 2500 字），大幅节省 Token */
    focus?: string;
    /** 缓存策略：'default' 优先读写磁盘 Markdown 缓存；'reload' 强制刷新请求上游 */
    cache?: 'default' | 'reload';
    /** 可选取消信号：触发时中止在途 HTTP 请求与浏览器页面操作 */
    signal?: AbortSignal;
};

export type HtmlExtractionResult = {
    title: string;
    text: string;
    html?: string;
    mode: 'container' | 'body' | 'metadata';
};

export type ReadabilityArticle = {
    title?: string | null;
    byline?: string | null;
    content?: string | null;
    textContent?: string | null;
    excerpt?: string | null;
    siteName?: string | null;
    length?: number | null;
};

/** jsdom（optionalDependencies）缺失：readability 与链接提取都不可用，需显式告知调用方而非静默降级 */
export class JsdomUnavailableError extends AppError {
    constructor(message: string) {
        super({ code: 'missing_optional_dependency', message, retryable: false });
        this.name = 'JsdomUnavailableError';
    }
}

export class ReadabilityUnavailableError extends AppError {
    constructor(message: string) {
        super({ code: 'missing_optional_dependency', message, retryable: false });
        this.name = 'ReadabilityUnavailableError';
    }
}

// 请求超时 10s：快速失败优先——慢页面（如部分海外站点直连）10s 内不响应就报错，
// 让 LLM 及时转 Context7 / 其他路径，而不是占用客户端 30s MCP 超时上限
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_CHARS = 30000;
// 执行层允许的最小 maxChars 为 100（CLI 直调可抓小片段）；
// MCP 工具 schema 层面仍限制 1000，不影响 MCP 调用契约
export const MIN_MAX_CHARS = 100;
export const MAX_MAX_CHARS = 200000;
/** 响应体硬上限：2MB（与 maxBodyLength/maxContentLength 一致） */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

export const FETCH_WEB_COOKIE_BUDGET_MS = 15000;
export const FETCH_WEB_BROWSER_BUDGET_MS = 30000;
export const FETCH_WEB_TOTAL_BUDGET_MS = 25000;

export function clampMaxChars(value: number): number {
    return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, value));
}
