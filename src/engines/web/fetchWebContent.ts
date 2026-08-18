import * as cheerio from 'cheerio';
import { config } from '../../config.js';
import { buildAxiosRequestOptions, hintProxyConnectionError, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from '../../utils/urlSafety.js';
import {
    fetchPageHtmlWithBrowser,
    getBrowserCookieHeader,
    looksLikeBotChallengePage
} from '../../utils/browserCookies.js';

// jsdom 是 optionalDependencies（仅 readability/链接提取使用）：
// 延迟加载，缺失时相关功能报明确错误，不拖垮整个模块加载。
let jsdomModulePromise: Promise<typeof import('jsdom')> | null = null;
function loadJsdom(): Promise<typeof import('jsdom')> {
    if (!jsdomModulePromise) {
        jsdomModulePromise = import('jsdom').catch((error) => {
            if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
                throw new Error('jsdom is not available (optional dependency not installed); readability/link extraction is disabled');
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
    readableHtml?: string;
    links?: ExtractedLink[];
    byline?: string;
    excerpt?: string;
    siteName?: string;
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

/** 按 URL 路径扩展名判断"明显的小文件"：跳过 HEAD 预检（见 fetchWebContent） */
function isLikelySmallFile(parsedUrl: URL): boolean {
    const path = parsedUrl.pathname.toLowerCase();
    return /\.(md|markdown|txt|text|json|csv|xml|ya?ml|html?|png|jpe?g|gif|webp|svg|ico|css|js|pdf)$/.test(path);
}
const MIN_METADATA_FALLBACK_CHARS = 200;

type HtmlExtractionResult = {
    title: string;
    text: string;
    mode: 'container' | 'body' | 'metadata';
};

type ReadabilityArticle = {
    title?: string | null;
    byline?: string | null;
    content?: string | null;
    textContent?: string | null;
    excerpt?: string | null;
    siteName?: string | null;
    length?: number | null;
};

class ReadabilityUnavailableError extends Error {}

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
    return process.env.OPEN_WEBSEARCH_DEBUG === '1';
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
        return new readabilityModule.Readability(dom.window.document).parse();
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
    let mode: HtmlExtractionResult['mode'] = 'metadata';
    for (const selector of preferredContainers) {
        const container = $(selector).first();
        if (container.length === 0) {
            continue;
        }

        const candidate = normalizeText(container.text());
        if (candidate.length >= 120) {
            selectedText = candidate;
            mode = 'container';
            break;
        }
    }

    if (!selectedText) {
        const body = $('body');
        selectedText = normalizeText((body.length > 0 ? body : $.root() as any).text());
        if (selectedText) {
            mode = 'body';
        }
    }

    // SPA pages often render content by JS and leave body nearly empty.
    // Fall back to metadata so callers still get useful page info.
    if (!selectedText) {
        selectedText = normalizeText([title, metaDescription].filter(Boolean).join('\n\n'));
        mode = 'metadata';
    }

    return { title, text: selectedText, mode };
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

function buildRequestOptions(cookieHeader?: string): any {
    const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Accept': 'text/markdown,text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    const requestOptions = buildAxiosRequestOptions({
        allowInsecureTls: config.fetchWebAllowInsecureTls,
        decompress: true,
        headers,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxRedirects: 5,
        // arraybuffer 以便按页面声明的 charset 解码（axios 的 text 模式固定按 UTF-8，GBK 中文站会乱码）
        responseType: 'arraybuffer',
        timeout: DEFAULT_TIMEOUT_MS,
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
function decodeResponseBuffer(buffer: ArrayBuffer, contentType: string): string {
    const bytes = new Uint8Array(buffer);

    // 1) 从 Content-Type 头提取 charset
    let charset = '';
    const charsetMatch = contentType.match(/charset=["']?([\w-]+)["']?/i);
    if (charsetMatch) {
        charset = charsetMatch[1];
    }

    // 2) 从 HTML 前 1024 字节的 meta charset 提取
    if (!charset) {
        const headSample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 1024));
        const metaMatch = headSample.match(/<meta[^>]+charset=["']?([\w-]+)["']?/i);
        if (metaMatch) {
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
function decodeRawResponse(response: any, contentType: string): string {
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

async function fetchHtmlViaBrowser(url: string): Promise<{ contentType: string; finalUrl: string; raw: string; title: string } | undefined> {
    try {
        const browserPage = await browserHtmlFetcher(url);
        assertPublicHttpUrl(browserPage.finalUrl, 'Final URL');

        return {
            contentType: 'text/html; charset=utf-8',
            finalUrl: browserPage.finalUrl,
            raw: browserPage.html,
            title: browserPage.title
        };
    } catch {
        return undefined;
    }
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
            return new readabilityModule.Readability(dom.window.document).parse();
        } catch (error) {
            if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
                throw new ReadabilityUnavailableError('Mozilla Readability is not available. Install `@mozilla/readability` to use readability mode.');
            }
            throw error;
        }
    });
}

async function tryRequestWithBrowserCookies(url: string): Promise<{ response?: any; usedBrowserCookies: boolean }> {
    let cookieHeader: string | undefined;
    try {
        cookieHeader = await getBrowserCookieHeader(url);
    } catch {
        return { response: undefined, usedBrowserCookies: false };
    }

    if (!cookieHeader) {
        return { response: undefined, usedBrowserCookies: false };
    }

    try {
        return {
            response: await requestWithSafeRedirects('GET', url, buildRequestOptions(cookieHeader), 'Request URL'),
            usedBrowserCookies: true
        };
    } catch {
        return {
            response: undefined,
            usedBrowserCookies: true
        };
    }
}

export async function fetchWebContent(
    url: string,
    maxChars: number = DEFAULT_MAX_CHARS,
    options: FetchWebContentOptions = {}
): Promise<FetchWebContentResult> {
    const parsedUrl = new URL(url);
    await assertPublicHttpUrlResolved(parsedUrl, 'Request URL');

    const startIndex = Math.max(0, Math.floor(options.startIndex ?? 0));
    const targetMaxChars = clampMaxChars(maxChars);

    const requestOptions = buildRequestOptions();

    // Pre-flight check to avoid downloading oversized payloads when Content-Length is present.
    // 明显的小文件（.md/.txt/.json 等）跳过 HEAD 预检：HEAD 一次延迟翻倍，
    // 这些类型超 2MB 上限的概率极低，且部分站点禁 HEAD 会白等超时。
    // GET 请求自带 maxBodyLength 硬上限兜底（见 buildRequestOptions）。
    if (!isLikelySmallFile(parsedUrl)) {
        try {
            const headResponse = await requestWithSafeRedirects('HEAD', parsedUrl.toString(), {
                ...requestOptions,
                responseType: 'json',
                validateStatus: (status: number) => status >= 200 && status < 400
            }, 'Request URL');
            const headLength = Number(headResponse.headers['content-length']);
            if (Number.isFinite(headLength) && headLength > MAX_DOWNLOAD_BYTES) {
                const tooLargeError = new Error(`Response body too large (${headLength} bytes). Max allowed is ${MAX_DOWNLOAD_BYTES} bytes`);
                (tooLargeError as any).code = 'ERR_RESPONSE_TOO_LARGE';
                throw tooLargeError;
            }
        } catch (error: any) {
            if (error?.code === 'ERR_RESPONSE_TOO_LARGE') {
                throw error;
            }
            const status = error?.response?.status;
            // Some servers don't support HEAD correctly; continue and rely on GET download limits.
            // 429（限流）与 5xx（服务端暂时故障）也不作为 HEAD 预检的致命错误——GET 可能成功或由上层重试处理。
            if (status !== undefined && ![400, 403, 404, 405, 406, 429, 501].includes(status) && status < 500) {
                throw error;
            }
        }
    }

    let response: any;
    let usedBrowserCookies = false;
    let retrievalMethod: FetchWebContentResult['retrievalMethod'] = 'request';
    // 记录 cookie 重试失败时的原始 HTTP 状态（401/403/429），供最终错误分类使用
    let httpErrorStatus: number | undefined;

    try {
        response = await requestWithSafeRedirects('GET', parsedUrl.toString(), requestOptions, 'Request URL');
    } catch (error: any) {
        const status = error?.response?.status;
        if (![401, 403, 429].includes(status)) {
            throw hintProxyConnectionError(error);
        }

        const cookieRetry = await tryRequestWithBrowserCookies(parsedUrl.toString());
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
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: '',
                request: { res: { responseUrl: parsedUrl.toString() } }
            };
        }
    }

    let contentType = String(response.headers['content-type'] || '').toLowerCase();
    let finalUrl = response.request?.res?.responseUrl || parsedUrl.toString();
    assertPublicHttpUrl(finalUrl, 'Final URL');
    let raw = decodeRawResponse(response, contentType);

    if (!usedBrowserCookies && looksLikeBotChallengePage(raw)) {
        const cookieRetry = await tryRequestWithBrowserCookies(parsedUrl.toString());
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
        throw new Error(`Response body too large (${contentLength} bytes). Max allowed is ${MAX_DOWNLOAD_BYTES} bytes`);
    }

    let title = '';
    let extractedContent = '';
    let htmlExtraction: HtmlExtractionResult | undefined;
    let readabilityApplied = false;
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
        } else if (isMarkdownContentType(contentType)) {
            extractedContent = normalizeText(raw);
        } else {
            extractedContent = normalizeText(raw);
        }

        if (shouldTryBrowserHtmlFallback(contentType, raw, htmlExtraction)) {
            const browserResult = await fetchHtmlViaBrowser(parsedUrl.toString());
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

        if (options.readability && (contentType.includes('text/html') || looksLikeHtml(raw))) {
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
                        extractedContent = readableText;
                    }
                } else {
                    logReadabilityFallback('parser returned no article content');
                }
            } catch (error) {
                if (error instanceof ReadabilityUnavailableError) {
                    throw error;
                }

                logReadabilityFallback('falling back to existing extractor after parser error', error);
            }
        }
    }

    if (!extractedContent) {
        // 若此前 cookie 重试曾遇 401/403/429，抛出带状态码的错误，便于上层分类为可重试的 upstream 错误
        if (httpErrorStatus !== undefined) {
            const httpError = new Error(
                `Request failed with HTTP ${httpErrorStatus} and no readable content was extracted (${parsedUrl.toString()})`
            );
            (httpError as any).status = httpErrorStatus;
            throw httpError;
        }
        throw new Error('No readable content was extracted from this URL');
    }

    const totalLength = extractedContent.length;
    // startIndex 越界时显式报错，避免静默返回空内容
    if (startIndex >= totalLength) {
        const outOfRangeError = new Error(
            `startIndex ${startIndex} is beyond content length ${totalLength}; reset to 0 to read from the beginning`
        );
        (outOfRangeError as any).code = 'ERR_START_INDEX_OUT_OF_RANGE';
        throw outOfRangeError;
    }
    const pageContent = extractedContent.slice(startIndex, startIndex + targetMaxChars);
    const truncated = startIndex + targetMaxChars < totalLength;
    const content = truncated
        ? `${pageContent}\n\n[truncated; continue with startIndex=${startIndex + pageContent.length}]`
        : pageContent;

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
        ...(options.includeReadableHtml && readableHtml ? { readableHtml } : {}),
        ...(links ? { links } : {}),
        ...(byline ? { byline } : {}),
        ...(excerpt ? { excerpt } : {}),
        ...(siteName ? { siteName } : {})
    };
}
