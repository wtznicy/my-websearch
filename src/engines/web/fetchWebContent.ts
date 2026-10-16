import * as cheerio from 'cheerio';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { config } from '../../config.js';
import { buildAxiosRequestOptions, hintProxyConnectionError, requestDirectFirst, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from '../../utils/urlSafety.js';
import { htmlToMarkdown } from '../../utils/markdown.js';
import {
    fetchPageHtmlWithBrowser,
    getBrowserCookieHeader,
    looksLikeBotChallengePage
} from '../../utils/browserCookies.js';
import { purifySiteContent } from './sitePurifiers.js';
import { AppError } from '../../core/errors.js';

// jsdom 是 optionalDependencies（仅 readability/链接提取使用）：
// 延迟加载，缺失时相关功能报明确错误，不拖垮整个模块加载。
let jsdomModulePromise: Promise<typeof import('jsdom')> | null = null;
function loadJsdom(): Promise<typeof import('jsdom')> {
    if (!jsdomModulePromise) {
        jsdomModulePromise = import('jsdom').catch((error) => {
            if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
                throw new JsdomUnavailableError('jsdom is not available (optional dependency not installed); readability/link extraction is disabled');
            }
            throw error;
        });
    }
    return jsdomModulePromise;
}

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
    /** 可选取消信号：触发时中止在途 HTTP 请求与浏览器页面操作 */
    signal?: AbortSignal;
};

// 请求超时 10s：快速失败优先——慢页面（如部分海外站点直连）10s 内不响应就报错，
// 让 LLM 及时转 Context7 / 其他路径，而不是占用客户端 30s MCP 超时上限
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_CHARS = 30000;
// 执行层允许的最小 maxChars 为 100（CLI 直调可抓小片段）；
// MCP 工具 schema 层面仍限制 1000，不影响 MCP 调用契约
const MIN_MAX_CHARS = 100;
const MAX_MAX_CHARS = 200000;
/** 响应体硬上限：2MB（与 maxBodyLength/maxContentLength 一致） */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

/** 按 URL 路径扩展名判断"明显的小文件"：跳过 HEAD 预检（见 fetchWebContent，注意 .pdf 不跳过预检） */
function isLikelySmallFile(parsedUrl: URL): boolean {
    const path = parsedUrl.pathname.toLowerCase();
    return /\.(md|markdown|txt|text|json|csv|xml|ya?ml|html?|png|jpe?g|gif|webp|svg|ico|css|js)$/.test(path);
}
const MIN_METADATA_FALLBACK_CHARS = 200;

type HtmlExtractionResult = {
    title: string;
    text: string;
    html?: string;
    mode: 'container' | 'body' | 'metadata';
};

const CHROME_NOISE_SELECTOR = [
    'nav',
    'header',
    'footer',
    'aside',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '.sidebar',
    '.navbar',
    '.breadcrumb',
    '.pagination',
    '.page-footer',
    '.article-footer',
    '.doc-footer',
    '.edit-on-github',
    '.bc-github-link',
    '#footer',
    'aside.metadata'
].join(', ');

/**
 * 探测站点在页面顶部或 `<link rel="alternate" type="text/markdown">` 中声明的 LLM 专用 Markdown 地址
 * （如 Vue.js 文档页顶部的 "Are you an LLM? You can read better optimized documentation at /guide/.../computed.md"）。
 * 仅允许同源且路径为 `.md` / `.markdown` / `.mdx` 的地址，防止跳转到外部任意 URL。
 */
export function detectLlmMarkdownUrl(rawHtml: string, extractedText: string, baseUrl: string): string | null {
    let baseParsed: URL;
    try {
        baseParsed = new URL(baseUrl);
    } catch {
        return null;
    }

    const resolveSameOriginMd = (candidate: string): string | null => {
        const cleaned = candidate.trim().replace(/[).,;:'"]+$/, '');
        if (!cleaned) {
            return null;
        }
        try {
            const resolved = new URL(cleaned, baseParsed);
            if (resolved.origin !== baseParsed.origin) {
                return null;
            }
            if (!isMarkdownPath(resolved)) {
                return null;
            }
            if (resolved.toString() === baseParsed.toString()) {
                return null;
            }
            return resolved.toString();
        } catch {
            return null;
        }
    };

    const headSnippet = rawHtml.slice(0, 6000);
    const linkMatch = headSnippet.match(/<link\b[^>]*rel=["']alternate["'][^>]*type=["']text\/(?:x-)?markdown["'][^>]*>/i)
        || headSnippet.match(/<link\b[^>]*type=["']text\/(?:x-)?markdown["'][^>]*rel=["']alternate["'][^>]*>/i);
    if (linkMatch) {
        const hrefMatch = linkMatch[0].match(/\bhref=["']([^"']+)["']/i);
        if (hrefMatch?.[1]) {
            const resolved = resolveSameOriginMd(hrefMatch[1]);
            if (resolved) {
                return resolved;
            }
        }
    }

    const leadingText = `${extractedText.slice(0, 800)}\n${headSnippet}`;
    const llmPromptPatterns = [
        /Are you an LLM\?[\s\S]{0,240}?(https?:\/\/[^\s"'<>)+,]+\.(?:md|markdown|mdx)|\/[A-Za-z0-9._/-]+\.(?:md|markdown|mdx))\b/i,
        /(?:for\s+LLMs?|LLM-friendly|AI\s+agent|language\s+model)[^\n.]{0,180}?(https?:\/\/[^\s"'<>)+,]+\.(?:md|markdown|mdx)|\/[A-Za-z0-9._/-]+\.(?:md|markdown|mdx))\b/i
    ];
    for (const pattern of llmPromptPatterns) {
        const match = leadingText.match(pattern);
        if (match?.[1]) {
            const resolved = resolveSameOriginMd(match[1]);
            if (resolved) {
                return resolved;
            }
        }
    }

    return null;
}

/**
 * 在克隆节点上剥离导航栏/侧边栏/页脚等非正文区块。
 * 若剥离后剩余正文长度仍达标（>= minChars），则采用净化后的节点；
 * 否则保留原节点（防止短页面或把正文写在 header 里的非常规页面被误清空）。
 *
 * 剥离时**保留噪声节点内的 h1/h2 标题**：`<article><header><h1>标题</h1></header>` 是
 * 博客/资讯站的常见结构（实测 blog.vuejs.org/posts/vue-3-5：整篇正文的 H1 在 <header> 里，
 * 直接 remove 会让提取结果丢掉文章标题——旧逻辑 6905 字符含标题，剥离后 6584 字符标题消失）。
 * 只救 h1/h2：它们承载标题语义；nav/侧边栏里的 h3~h6 多为栏目标签，属噪声。
 */
function stripChromeNoiseWithGuard(
    $: cheerio.CheerioAPI,
    element: ReturnType<cheerio.CheerioAPI>,
    minChars: number
): { text: string; html: string } {
    const rawText = normalizeText(element.text());
    const rawHtml = element.html() || '';
    const cloned = element.clone();
    cloned.find(CHROME_NOISE_SELECTOR).each((_, node) => {
        const noise = $(node);
        const headings = noise.find('h1, h2');
        if (headings.length > 0) {
            noise.before(headings.clone());
        }
        noise.remove();
    });
    const cleanedText = normalizeText(cloned.text());
    if (cleanedText.length >= minChars || (rawText.length < minChars && cleanedText.length > 0)) {
        return { text: cleanedText, html: cloned.html() || rawHtml };
    }
    return { text: rawText, html: rawHtml };
}

type ReadabilityArticle = {
    title?: string | null;
    byline?: string | null;
    content?: string | null;
    textContent?: string | null;
    excerpt?: string | null;
    siteName?: string | null;
    length?: number | null;
};

class ReadabilityUnavailableError extends AppError {
    constructor(message: string) {
        super({ code: 'missing_optional_dependency', message, retryable: false });
        this.name = 'ReadabilityUnavailableError';
    }
}

/** jsdom（optionalDependencies）缺失：readability 与链接提取都不可用，需显式告知调用方而非静默降级 */
export class JsdomUnavailableError extends AppError {
    constructor(message: string) {
        super({ code: 'missing_optional_dependency', message, retryable: false });
        this.name = 'JsdomUnavailableError';
    }
}

function normalizeText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function clampMaxChars(value: number): number {
    return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, value));
}

function looksLikeHtml(raw: string): boolean {
    return /<!doctype html|<html[\s>]|<body[\s>]/i.test(raw);
}

function isMarkdownPath(url: URL): boolean {
    const pathname = url.pathname.toLowerCase();
    return pathname.endsWith('.md') || pathname.endsWith('.markdown') || pathname.endsWith('.mdx');
}

function shouldDebugReadabilityFallback(): boolean {
    return (process.env.LOG_LEVEL ?? '').toLowerCase() === 'debug';
}

function logReadabilityFallback(message: string, error?: unknown): void {
    if (!shouldDebugReadabilityFallback()) {
        return;
    }

    if (error instanceof Error) {
        console.error(`[fetchWebContent/readability] ${message}: ${error.message}`);
        return;
    }

    console.error(`[fetchWebContent/readability] ${message}`);
}

function isMarkdownContentType(contentType: string): boolean {
    const ct = contentType.toLowerCase();
    return ct.includes('text/markdown') || ct.includes('application/markdown') || ct.includes('text/x-markdown');
}

let browserHtmlFetcher: typeof fetchPageHtmlWithBrowser = fetchPageHtmlWithBrowser;
let readabilityParser: (html: string, finalUrl: string) => Promise<ReadabilityArticle | null> = async (html, finalUrl) => {
    try {
        const moduleName = '@mozilla/readability';
        const readabilityModule = await import(moduleName);
        const { JSDOM } = await loadJsdom();
        const dom = new JSDOM(html, { url: finalUrl });
        // keepClasses：Readability 默认会剥掉所有 class，而代码块语言只存在于
        // `<code class="language-x">` / 外层 `language-x` 容器上——剥掉后下游 Markdown 转换
        // 拿不到语言（实测 readability:true 时 7 个围栏 0 带语言 + 语言标签漏成正文；不传 readability 时 7/7 带语言）
        return new readabilityModule.Readability(dom.window.document, { keepClasses: true }).parse();
    } catch (error) {
        if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
            throw new ReadabilityUnavailableError('Mozilla Readability is not available. Install `@mozilla/readability` to use readability mode.');
        }
        throw error;
    }
};

function extractMainTextFromHtml(html: string): HtmlExtractionResult {
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() ||
        $('meta[property="og:description"]').attr('content')?.trim() ||
        '';

    $('script, style, noscript, template, iframe, svg, canvas').remove();

    const preferredContainers = [
        'article',
        'main',
        '[role="main"]',
        '.markdown-body',
        '.article-content',
        '.post-content',
        '.entry-content',
        '.content'
    ];

    let selectedText = '';
    let selectedHtml: string | undefined;
    let mode: HtmlExtractionResult['mode'] = 'metadata';
    for (const selector of preferredContainers) {
        const container = $(selector).first();
        if (container.length === 0) {
            continue;
        }

        const { text: candidate, html: candidateHtml } = stripChromeNoiseWithGuard($, container, 120);
        if (candidate.length >= 120) {
            selectedText = candidate;
            selectedHtml = candidateHtml;
            mode = 'container';
            break;
        }
    }

    if (!selectedText) {
        const body = $('body');
        const target = body.length > 0 ? body : ($.root() as unknown as ReturnType<cheerio.CheerioAPI>);
        const { text: bodyText, html: bodyHtml } = stripChromeNoiseWithGuard($, target, 120);
        if (bodyText) {
            selectedText = bodyText;
            selectedHtml = bodyHtml;
            mode = 'body';
        }
    }

    // SPA pages often render content by JS and leave body nearly empty.
    // Fall back to metadata so callers still get useful page info.
    if (!selectedText) {
        selectedText = normalizeText([title, metaDescription].filter(Boolean).join('\n\n'));
        mode = 'metadata';
    }

    return { title, text: selectedText, html: selectedHtml, mode };
}

async function extractReadableTextFromHtml(html: string): Promise<string> {
    const { JSDOM } = await loadJsdom();
    const dom = new JSDOM(html);
    return normalizeText(dom.window.document.body.textContent || '');
}

async function extractReadableLinks(html: string, finalUrl: string): Promise<ExtractedLink[]> {
    const { JSDOM } = await loadJsdom();
    const dom = new JSDOM(html, { url: finalUrl });
    const anchors = Array.from(dom.window.document.querySelectorAll('a[href]'));
    const seen = new Set<string>();
    const links: ExtractedLink[] = [];

    for (const anchor of anchors) {
        const rawHref = anchor.getAttribute('href');
        if (!rawHref) {
            continue;
        }

        let href: string;
        try {
            href = new URL(rawHref, finalUrl).toString();
            assertPublicHttpUrl(href, 'Extracted link URL');
        } catch {
            continue;
        }

        if (seen.has(href)) {
            continue;
        }
        seen.add(href);

        links.push({
            text: normalizeText(anchor.textContent || ''),
            href
        });
    }

    return links;
}

import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';

function buildRequestOptions(cookieHeader?: string, forceDirect = false, signal?: AbortSignal): AxiosRequestConfig {
    const headers: Record<string, string> = {
        'User-Agent': DEFAULT_DESKTOP_UA,
        'Accept': 'text/markdown,text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    // 国内站点（.cn/已知国内域名）直连，不因全局 USE_PROXY 走代理——代理挂掉时国内抓取不受影响
    const requestOptions = buildAxiosRequestOptions({
        allowInsecureTls: config.fetchWebAllowInsecureTls,
        decompress: true,
        headers,
        forceDirect,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxRedirects: 5,
        // arraybuffer 以便按页面声明的 charset 解码（axios 的 text 模式固定按 UTF-8，GBK 中文站会乱码）
        responseType: 'arraybuffer',
        timeout: DEFAULT_TIMEOUT_MS,
        signal
    });

    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    return requestOptions;
}

/**
 * 从 Content-Type 头或 HTML meta 中探测 charset，并用 TextDecoder 解码原始字节。
 * 中文站点常用 GBK/GB2312，axios 的 text 模式固定按 UTF-8 会导致乱码。
 */
function decodeResponseBuffer(buffer: ArrayBuffer | Uint8Array, contentType: string): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    // 1) 从 Content-Type 头提取 charset
    let charset = '';
    const charsetMatch = contentType.match(/charset=["']?([\w-]+)["']?/i);
    if (charsetMatch?.[1]) {
        charset = charsetMatch[1];
    }

    // 2) 从 HTML 前 1024 字节的 meta charset 提取
    if (!charset) {
        const headSample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 1024));
        const metaMatch = headSample.match(/<meta[^>]+charset=["']?([\w-]+)["']?/i);
        if (metaMatch?.[1]) {
            charset = metaMatch[1];
        }
    }

    // 3) 归一化并解码；GBK/GB2312/GB18030 都按 GB18030 处理（超集）
    const normalized = charset.toLowerCase();
    try {
        if (normalized === 'gbk' || normalized === 'gb2312' || normalized === 'gb18030' || normalized === 'gb_2312') {
            return new TextDecoder('gb18030').decode(bytes);
        }
        if (normalized && normalized !== 'utf-8' && normalized !== 'utf8') {
            return new TextDecoder(normalized).decode(bytes);
        }
    } catch {
        // 未知编码或 TextDecoder 不支持，回退 UTF-8
    }
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 统一把响应体解码为字符串：responseType 为 arraybuffer 时按页面 charset 解码；
 * 字符串原样返回；其他类型（JSON 等）转为格式化文本。
 * 主请求与 cookie 重试都必须走这里，否则 Buffer 会被 JSON.stringify 成数字数组。
 */
function decodeRawResponse(response: AxiosResponse, contentType: string): string {
    return response.data instanceof ArrayBuffer || response.data instanceof Uint8Array
        ? decodeResponseBuffer(response.data, contentType)
        : typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data, null, 2);
}

function shouldTryBrowserHtmlFallback(contentType: string, raw: string, extraction?: HtmlExtractionResult): boolean {
    if (looksLikeBotChallengePage(raw)) {
        return true;
    }

    if (contentType.includes('text/html') || looksLikeHtml(raw)) {
        return extraction?.mode === 'metadata' && extraction.text.length < MIN_METADATA_FALLBACK_CHARS;
    }

    return false;
}

async function fetchHtmlViaBrowser(
    url: string,
    signal?: AbortSignal
): Promise<{ contentType: string; finalUrl: string; raw: string; title: string } | undefined> {
    try {
        const browserPage = await browserHtmlFetcher(url, signal);
        assertPublicHttpUrl(browserPage.finalUrl, 'Final URL');

        return {
            contentType: 'text/html; charset=utf-8',
            finalUrl: browserPage.finalUrl,
            raw: browserPage.html,
            title: browserPage.title
        };
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        return undefined;
    }
}

let browserCookieHeaderGetter = getBrowserCookieHeader;

export function __setBrowserCookieHeaderForTests(getter?: typeof getBrowserCookieHeader): void {
    browserCookieHeaderGetter = getter || getBrowserCookieHeader;
}

export function __setBrowserHtmlFetcherForTests(fetcher?: typeof fetchPageHtmlWithBrowser): void {
    browserHtmlFetcher = fetcher || fetchPageHtmlWithBrowser;
}

export function __setReadabilityParserForTests(parser?: (html: string, finalUrl: string) => Promise<ReadabilityArticle | null>): void {
    readabilityParser = parser || (async (html, finalUrl) => {
        try {
            const moduleName = '@mozilla/readability';
            const readabilityModule = await import(moduleName);
            const { JSDOM } = await loadJsdom();
            const dom = new JSDOM(html, { url: finalUrl });
            // keepClasses 同 defaultReadabilityParser：保住 `<code class="language-x">`，
            // 否则 readability 链路下的 Markdown 围栏必然丢语言
            return new readabilityModule.Readability(dom.window.document, { keepClasses: true }).parse();
        } catch (error) {
            if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
                throw new ReadabilityUnavailableError('Mozilla Readability is not available. Install `@mozilla/readability` to use readability mode.');
            }
            throw error;
        }
    });
}

async function tryRequestWithBrowserCookies(
    url: string,
    signal?: AbortSignal
): Promise<{ response?: AxiosResponse; usedBrowserCookies: boolean }> {
    let cookieHeader: string | undefined;
    try {
        cookieHeader = await browserCookieHeaderGetter(url, false, signal);
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        return { response: undefined, usedBrowserCookies: false };
    }

    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', message: 'Request aborted', retryable: false });
    }
    if (!cookieHeader) {
        return { response: undefined, usedBrowserCookies: false };
    }

    try {
        return {
            response: await requestWithSafeRedirects('GET', url, buildRequestOptions(cookieHeader, false, signal), 'Request URL'),
            usedBrowserCookies: true
        };
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        return {
            response: undefined,
            usedBrowserCookies: true
        };
    }
}

/**
 * 浏览器兜底（cookie 采集 + HTML 渲染）的分段独立懒启动预算。
 *
 * 架构分工（分段独立预算 + 进入阶段时才开始计时）：
 * 1. 预算计时器在首次进入对应阶段（withinBudget 调用）时才启动，前置的 HEAD / GET 请求耗时不会侵占浏览器阶段预算。
 * 2. withinBudget 接收惰性任务工厂 `(signal) => Promise<T>`：预算已耗尽时不启动新任务；阶段超时时通过 AbortSignal 主动中止底层请求与页面。
 */
const FETCH_WEB_COOKIE_BUDGET_MS = 15000;
const FETCH_WEB_BROWSER_BUDGET_MS = 30000;

export function createBrowserBudget(label: string, budgetMs = FETCH_WEB_BROWSER_BUDGET_MS, parentSignal?: AbortSignal) {
    let deadline: number | null = null;
    return function withinBudget<T>(task: (signal: AbortSignal) => Promise<T>, step: string): Promise<T> {
        if (parentSignal?.aborted) {
            return Promise.reject(
                parentSignal.reason instanceof Error
                    ? parentSignal.reason
                    : new AppError({
                        code: 'aborted',
                        retryable: false,
                        message: `${label} aborted before ${step}`
                    })
            );
        }
        if (deadline === null) {
            deadline = Date.now() + budgetMs;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            return Promise.reject(new AppError({
                code: 'network_timeout',
                retryable: true,
                message: `${label} browser fallback budget (${budgetMs}ms) exhausted before ${step}`
            }));
        }
        const controller = new AbortController();
        const onParentAbort = () => {
            controller.abort(
                parentSignal?.reason ?? new AppError({
                    code: 'aborted',
                    retryable: false,
                    message: `${label} aborted during ${step}`
                })
            );
        };
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                const timeoutError = new AppError({
                    code: 'network_timeout',
                    retryable: true,
                    message: `${label} browser fallback budget (${budgetMs}ms) exceeded during ${step}`
                });
                controller.abort(timeoutError);
                reject(timeoutError);
            }, remaining);
            if (typeof timer === 'object' && typeof timer.unref === 'function') {
                timer.unref();
            }
            Promise.resolve()
                .then(() => task(controller.signal))
                .then(
                    (value) => {
                        clearTimeout(timer);
                        parentSignal?.removeEventListener('abort', onParentAbort);
                        resolve(value);
                    },
                    (error) => {
                        clearTimeout(timer);
                        parentSignal?.removeEventListener('abort', onParentAbort);
                        reject(error);
                    }
                );
        });
    };
}

export async function fetchWebContent(
    url: string,
    maxChars: number = DEFAULT_MAX_CHARS,
    options: FetchWebContentOptions = {}
): Promise<FetchWebContentResult> {
    const { signal } = options;
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', message: 'fetchWebContent aborted', retryable: false });
    }

    const parsedUrl = new URL(url);
    await assertPublicHttpUrlResolved(parsedUrl, 'Request URL');

    const withinCookieBudget = createBrowserBudget('fetchWebContent cookie', FETCH_WEB_COOKIE_BUDGET_MS, signal);
    const withinBrowserBudget = createBrowserBudget('fetchWebContent render', FETCH_WEB_BROWSER_BUDGET_MS, signal);
    let startIndex = Math.max(0, Math.floor(options.startIndex ?? 0));
    const targetMaxChars = clampMaxChars(maxChars);

    // Pre-flight check to avoid downloading oversized payloads when Content-Length is present.
    // 明显的小文件（.md/.txt/.json 等）跳过 HEAD 预检：HEAD 一次延迟翻倍，
    // 这些类型超 2MB 上限的概率极低，且部分站点禁 HEAD 会白等超时。
    // GET 请求自带 maxBodyLength 硬上限兜底（见 buildRequestOptions）。
    if (!isLikelySmallFile(parsedUrl)) {
        try {
            // HEAD 预检与主请求同口径（直连优先、代理兜底）：此前写死 forceDirect=true，
            // 需代理的环境下直连 HEAD 会白等一次超时（且拿不到 Content-Length 预检）
            const headResponse = await requestDirectFirst('HEAD', parsedUrl.toString(), (forceDirect) => ({
                ...buildRequestOptions(undefined, forceDirect, signal),
                responseType: 'json',
                validateStatus: (status: number) => status >= 200 && status < 400
            }), 'Request URL');
            const headContentType = String(headResponse.headers['content-type'] || '').toLowerCase();
            if (headContentType.includes('application/pdf')) {
                throw new AppError({
                    code: 'invalid_arguments',
                    retryable: false,
                    message: 'PDF binary files (application/pdf) are not supported by fetchWebContent; maxChars only controls extracted text length, not binary download parsing'
                });
            }
            const headLength = Number(headResponse.headers['content-length']);
            if (Number.isFinite(headLength) && headLength > MAX_DOWNLOAD_BYTES) {
                throw new AppError({
                    code: 'response_too_large',
                    retryable: false,
                    details: { legacyCode: 'ERR_RESPONSE_TOO_LARGE' },
                    message: `Response body too large (${headLength} bytes). Max allowed is ${MAX_DOWNLOAD_BYTES} bytes`
                });
            }
        } catch (error: unknown) {
            if (signal?.aborted) {
                throw error;
            }
            const errCode = (error as { code?: string })?.code;
            if (errCode === 'ERR_RESPONSE_TOO_LARGE' || errCode === 'response_too_large' || errCode === 'invalid_arguments') {
                throw error;
            }
            // HEAD 预检只是"提前发现超大响应"的优化，任何失败都不应否决后续 GET：
            // 部分站点对 HEAD 直接回 401/402/407/410 等（对 GET 却正常），此前这些状态被当成致命错误
            // 直接终止抓取（测评报告 P1-8）。这里一律降级——继续用 GET + 下载上限兜底。
            void error;
        }
    }

    let response: AxiosResponse;
    let usedBrowserCookies = false;
    let retrievalMethod: FetchWebContentResult['retrievalMethod'] = 'request';
    // 记录 cookie 重试失败时的原始 HTTP 状态（401/403/429），供最终错误分类使用
    let httpErrorStatus: number | undefined;

    try {
        // 直连优先、代理兜底：先无代理（国内站点最优），网络失败且配置了代理时自动切换
        response = await requestDirectFirst('GET', parsedUrl.toString(), (forceDirect) => buildRequestOptions(undefined, forceDirect, signal), 'Request URL');
    } catch (error: unknown) {
        if (signal?.aborted) {
            throw error;
        }
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (typeof status !== 'number' || ![401, 403, 429].includes(status)) {
            throw hintProxyConnectionError(error);
        }

        let cookieRetry: { response?: AxiosResponse; usedBrowserCookies: boolean };
        try {
            cookieRetry = await withinCookieBudget((stageSignal) => tryRequestWithBrowserCookies(parsedUrl.toString(), stageSignal), 'cookie retry');
        } catch (cookieError) {
            if (signal?.aborted) {
                throw cookieError;
            }
            cookieRetry = { response: undefined, usedBrowserCookies: false };
        }

        if (cookieRetry.response) {
            response = cookieRetry.response;
            usedBrowserCookies = cookieRetry.usedBrowserCookies;
            retrievalMethod = 'request-with-browser-cookies';
        } else {
            // cookie 重试失败：记录原始 HTTP 状态，降级为空 response 继续走浏览器 fallback。
            // 若最终仍无内容，fetchWebContent 会在结尾用记录的 httpStatus 抛出带状态码的错误，
            // 避免 401/403/429 被掩盖成笼统的 "No readable content"。
            httpErrorStatus = status;
            response = {
                status: status || 200,
                statusText: 'OK',
                headers: { 'content-type': 'text/html; charset=utf-8' },
                config: {} as AxiosRequestConfig,
                data: '',
                request: { res: { responseUrl: parsedUrl.toString() } }
            } as AxiosResponse;
        }
    }

    let contentType = String(response.headers['content-type'] || '').toLowerCase();
    let finalUrl = response.request?.res?.responseUrl || parsedUrl.toString();
    assertPublicHttpUrl(finalUrl, 'Final URL');
    let raw = decodeRawResponse(response, contentType);

    if (contentType.includes('application/pdf') || raw.startsWith('%PDF-')) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: 'PDF binary files (application/pdf) are not supported by fetchWebContent; maxChars only controls extracted text length, not binary download parsing'
        });
    }

    if (!usedBrowserCookies && looksLikeBotChallengePage(raw)) {
        let cookieRetry: { response?: AxiosResponse; usedBrowserCookies: boolean };
        try {
            cookieRetry = await withinCookieBudget((stageSignal) => tryRequestWithBrowserCookies(parsedUrl.toString(), stageSignal), 'challenge cookie retry');
        } catch (cookieError) {
            if (signal?.aborted) {
                throw cookieError;
            }
            cookieRetry = { response: undefined, usedBrowserCookies: false };
        }

        if (cookieRetry.response) {
            response = cookieRetry.response;
            usedBrowserCookies = true;
            retrievalMethod = 'request-with-browser-cookies';
            contentType = String(response.headers['content-type'] || '').toLowerCase();
            finalUrl = response.request?.res?.responseUrl || parsedUrl.toString();
            assertPublicHttpUrl(finalUrl, 'Final URL');
            raw = decodeRawResponse(response, contentType);
        }
    }

    const contentLength = Number(response.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw new AppError({
            code: 'response_too_large',
            retryable: false,
            details: { legacyCode: 'ERR_RESPONSE_TOO_LARGE' },
            message: `Response body too large (${contentLength} bytes). Max allowed is ${MAX_DOWNLOAD_BYTES} bytes`
        });
    }

    let title = '';
    let extractedContent = '';
    let htmlExtraction: HtmlExtractionResult | undefined;
    let readabilityApplied = false;
    const degradedNotices: string[] = [];
    let readableHtml: string | undefined;
    let links: ExtractedLink[] | undefined;
    let byline: string | undefined;
    let excerpt: string | undefined;
    let siteName: string | undefined;

    const finalParsedUrl = new URL(finalUrl);

    // Raw mode: return the response body as-is (no extraction, no readability).
    if (options.raw) {
        extractedContent = normalizeText(raw);
    } else {
        // Keep raw markdown behavior for the resolved final path.
        if (isMarkdownPath(finalParsedUrl)) {
            extractedContent = normalizeText(raw);
        } else if (contentType.includes('text/html') || looksLikeHtml(raw)) {
            htmlExtraction = extractMainTextFromHtml(raw);
            title = htmlExtraction.title;
            extractedContent = htmlExtraction.text;

            // P2-4：若页面顶部或 <link rel="alternate" type="text/markdown"> 提示存在同源 LLM 专用 .md 版本
            // （如 Vue.js 文档页顶部的 "Are you an LLM? ... read /guide/.../computed.md"），自动改读该 .md 正文
            const llmMdUrl = detectLlmMarkdownUrl(raw, extractedContent, finalUrl);
            if (llmMdUrl) {
                try {
                    const mdParsed = new URL(llmMdUrl);
                    await assertPublicHttpUrlResolved(mdParsed, 'Alternate Markdown URL');
                    const mdResponse = await requestDirectFirst(
                        'GET',
                        llmMdUrl,
                        (forceDirect) => buildRequestOptions(undefined, forceDirect, signal),
                        'Alternate Markdown URL'
                    );
                    const mdContentType = String(mdResponse.headers['content-type'] || '').toLowerCase();
                    const mdRaw = decodeRawResponse(mdResponse, mdContentType);
                    const mdText = normalizeText(mdRaw);
                    if (mdText && !looksLikeHtml(mdRaw) && !looksLikeBotChallengePage(mdRaw)) {
                        finalUrl = mdResponse.request?.res?.responseUrl || llmMdUrl;
                        contentType = mdContentType || 'text/markdown';
                        raw = mdRaw;
                        extractedContent = mdText;
                        htmlExtraction = undefined;
                    }
                } catch (mdError) {
                    if (signal?.aborted) {
                        throw mdError;
                    }
                    void mdError;
                }
            }
        } else if (isMarkdownContentType(contentType)) {
            extractedContent = normalizeText(raw);
        } else {
            extractedContent = normalizeText(raw);
        }

        if (shouldTryBrowserHtmlFallback(contentType, raw, htmlExtraction)) {
            let browserResult: Awaited<ReturnType<typeof fetchHtmlViaBrowser>> = undefined;
            try {
                browserResult = await withinBrowserBudget((stageSignal) => fetchHtmlViaBrowser(parsedUrl.toString(), stageSignal), 'browser html fallback');
            } catch (browserError) {
                if (signal?.aborted) {
                    throw browserError;
                }
                console.warn('[fetchWebContent] Browser fallback failed or budget exhausted:', browserError instanceof Error ? browserError.message : String(browserError));
            }
            if (browserResult) {
                contentType = browserResult.contentType;
                finalUrl = browserResult.finalUrl;
                raw = browserResult.raw;
                retrievalMethod = 'browser-html';
                htmlExtraction = extractMainTextFromHtml(raw);
                title = htmlExtraction.title || browserResult.title;
                extractedContent = htmlExtraction.text;
            }
        }

        const sitePurified = (contentType.includes('text/html') || looksLikeHtml(raw))
            ? purifySiteContent(finalUrl || parsedUrl.toString(), raw)
            : undefined;

        if (sitePurified) {
            if (sitePurified.title) title = sitePurified.title;
            if (sitePurified.author) byline = sitePurified.author;
            if (sitePurified.siteName) siteName = sitePurified.siteName;
            readableHtml = sitePurified.html;
            if (options.format === 'markdown') {
                try {
                    const markdown = htmlToMarkdown(sitePurified.html);
                    extractedContent = markdown || sitePurified.text;
                } catch {
                    extractedContent = sitePurified.text;
                }
            } else {
                extractedContent = sitePurified.text;
            }
        } else if (options.readability && (contentType.includes('text/html') || looksLikeHtml(raw))) {
            try {
                const article = await readabilityParser(raw, finalUrl);
                if (article?.content) {
                    const readableText = normalizeText(article.textContent || await extractReadableTextFromHtml(article.content));
                    if (readableText) {
                        readabilityApplied = true;
                        readableHtml = article.content;
                        links = options.includeLinks ? await extractReadableLinks(article.content, finalUrl) : undefined;
                        byline = article.byline?.trim() || undefined;
                        excerpt = article.excerpt?.trim() || undefined;
                        siteName = article.siteName?.trim() || undefined;
                        title = article.title?.trim() || title;
                        // format=markdown：从 Readability DOM 转 Markdown（保留代码块语言/表格），
                        // 转换失败时回退纯文本；默认 format 为 text，行为不变
                        if (options.format === 'markdown') {
                            try {
                                const markdown = htmlToMarkdown(article.content);
                                extractedContent = markdown || readableText;
                            } catch (error) {
                                console.warn('Markdown conversion failed, falling back to plain text:', error instanceof Error ? error.message : String(error));
                                extractedContent = readableText;
                            }
                        } else {
                            extractedContent = readableText;
                        }
                    }
                } else {
                    logReadabilityFallback('parser returned no article content');
                    degradedNotices.push('readability: parser returned no article content (fell back to container extraction)');
                }
            } catch (error) {
                if (signal?.aborted) {
                    throw error;
                }
                if (error instanceof ReadabilityUnavailableError || error instanceof JsdomUnavailableError) {
                    throw error;
                }

                logReadabilityFallback('falling back to existing extractor after parser error', error);
                degradedNotices.push('readability: parser error (fell back to container extraction)');
            }
        }

        // 当调用方指定 format='markdown' 但未显式传 readability=true（或 Readability 未抽取出正文回退到容器提取）时，
        // 对已剥离导航噪音的主容器 HTML 执行 htmlToMarkdown，确保代码块与 GFM 表格不丢失
        if (options.format === 'markdown' && !readabilityApplied && htmlExtraction?.html && htmlExtraction.mode !== 'metadata') {
            try {
                const markdown = htmlToMarkdown(htmlExtraction.html);
                if (markdown) {
                    extractedContent = markdown;
                }
            } catch (error) {
                console.warn('Container Markdown conversion failed, falling back to plain text:', error instanceof Error ? error.message : String(error));
            }
        }
    }

    if (!options.raw) {
        // P0-5 统一出口判定：无论通过直接请求、cookie 重试还是浏览器渲染路径返回，
        // 若最终内容/标题命中反爬拦截特征且未能获得实质长正文，统一抛出 bot_challenge（兼容保留 legacyCode: ERR_BOT_CHALLENGE）
        const botDetected = looksLikeBotChallengePage(raw)
            || looksLikeBotChallengePage(extractedContent)
            || (Boolean(title) && looksLikeBotChallengePage(title));
        if (botDetected && extractedContent.length < 350) {
            throw new AppError({
                code: 'bot_challenge',
                retryable: false,
                status: httpErrorStatus || 403,
                details: { legacyCode: 'ERR_BOT_CHALLENGE' },
                message: '目标站点触发反爬验证或需要登录（命中反爬拦截特征），未能获取有效正文内容。'
            });
        }
    }

    if (!extractedContent) {
        // 若此前 cookie 重试曾遇 401/403/429，抛出带状态码的错误，便于上层分类为可重试的 upstream 错误
        if (httpErrorStatus !== undefined) {
            throw new AppError({
                code: httpErrorStatus === 429 ? 'rate_limited' : 'network_error',
                retryable: true,
                status: httpErrorStatus,
                message: `Request failed with HTTP ${httpErrorStatus} and no readable content was extracted (${parsedUrl.toString()})`
            });
        }
        throw new AppError({
            code: 'empty_content',
            retryable: false,
            message: 'No readable content was extracted from this URL'
        });
    }

    const totalLength = extractedContent.length;
    let pageContent = '';
    let truncated = false;
    let focused = false;
    let focusMatchOffset: number | undefined;

    if (options.focus && options.focus.trim()) {
        const focusTerm = options.focus.trim().toLowerCase();
        const lowerContent = extractedContent.toLowerCase();
        const focusIdx = lowerContent.indexOf(focusTerm);
        if (focusIdx !== -1) {
            focused = true;
            focusMatchOffset = focusIdx;
            const windowSize = 2500;
            const start = Math.max(0, focusIdx - windowSize);
            const end = Math.min(totalLength, focusIdx + focusTerm.length + windowSize);
            const snippet = extractedContent.slice(start, end);
            const prefix = start > 0 ? `[... focused on "${options.focus}" at offset ${focusIdx}, showing ${start}-${end} of ${totalLength} ...]\n\n` : '';
            const suffix = end < totalLength ? `\n\n[... truncated; continue with startIndex=${end} or specify another focus ...]` : '';
            pageContent = `${prefix}${snippet}${suffix}`;
            startIndex = start;
            truncated = start > 0 || end < totalLength;
        }
    }

    if (!focused) {
        // startIndex 越界时显式报错，避免静默返回空内容，同时在 details/hint 中明确返回实际 totalLength
        if (startIndex >= totalLength) {
            throw new AppError({
                code: 'start_index_out_of_range',
                retryable: false,
                details: { legacyCode: 'ERR_START_INDEX_OUT_OF_RANGE', totalLength, startIndex },
                hint: `当前正文实际总长度为 totalLength=${totalLength}，请将 startIndex 设为小于 ${totalLength} 的偏移量（或重置为 0 从头读取）。`,
                message: `startIndex ${startIndex} is beyond content length ${totalLength}; reset to 0 to read from the beginning`
            });
        }
        pageContent = extractedContent.slice(startIndex, startIndex + targetMaxChars);
        truncated = startIndex + targetMaxChars < totalLength;
    }

    const content = (!focused && truncated)
        ? `${pageContent}\n\n[truncated; continue with startIndex=${startIndex + pageContent.length}]`
        : pageContent;

    const toc = (truncated && !options.raw) ? generateMarkdownToc(extractedContent) : undefined;

    return {
        url: parsedUrl.toString(),
        finalUrl,
        contentType: contentType || 'unknown',
        title,
        retrievalMethod,
        truncated,
        content,
        ...(options.raw ? { raw } : {}),
        totalLength,
        startIndex,
        ...(truncated ? { hasMore: true, nextStartIndex: startIndex + pageContent.length } : {}),
        ...(options.readability ? { readabilityApplied } : {}),
        ...(degradedNotices.length > 0 ? { degraded: degradedNotices } : {}),
        ...(options.includeReadableHtml && readableHtml ? { readableHtml } : {}),
        ...(options.format === 'markdown' ? { format: 'markdown' as const } : {}),
        ...(links ? { links } : {}),
        ...(byline ? { byline } : {}),
        ...(excerpt ? { excerpt } : {}),
        ...(siteName ? { siteName } : {}),
        ...(toc && toc.length > 0 ? { toc } : {}),
        ...(focused ? { focused: true, focusMatchOffset } : {})
    };
}

export function generateMarkdownToc(markdown: string): string[] {
    const headingRegex = /(?:^|\n)(#{1,3})\s+([^\n\r]+)/g;
    const toc: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = headingRegex.exec(markdown)) !== null) {
        const level = match[1];
        const title = match[2]?.trim() ?? '';
        const offset = match.index + (match[0].startsWith('\n') ? 1 : 0);
        if (title) {
            const cleanTitle = title.length > 50 ? title.slice(0, 47) + '...' : title;
            toc.push(`${level} ${cleanTitle} (${offset})`);
        }
    }
    return toc;
}
