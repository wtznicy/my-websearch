import path from 'node:path';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { AppError } from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';
import { hintProxyConnectionError, requestDirectFirst } from '../../utils/httpRequest.js';
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from '../../utils/urlSafety.js';
import { htmlToMarkdown } from '../../utils/markdown.js';
import { looksLikeBotChallengePage } from '../../utils/browserCookies.js';
import { extractPdfText, isPdfResponse, MAX_PDF_DOWNLOAD_BYTES } from './pdfExtractor.js';
import { purifySiteContent } from './sitePurifiers.js';

// Types & Errors
import {
    clampMaxChars,
    ExtractedLink,
    FETCH_WEB_COOKIE_BUDGET_MS,
    FETCH_WEB_BROWSER_BUDGET_MS,
    FetchWebContentOptions,
    FetchWebContentResult,
    HtmlExtractionResult,
    JsdomUnavailableError,
    MAX_DOWNLOAD_BYTES,
    ReadabilityUnavailableError
} from './types.js';

// Transport
import {
    buildRequestOptions,
    createBrowserBudget,
    decodeRawResponse,
    fetchHtmlViaBrowser,
    isLikelySmallFile,
    shouldTryBrowserHtmlFallback,
    tryRequestWithBrowserCookies
} from './transport.js';

// Extraction
import {
    detectLlmMarkdownUrl,
    extractMainTextFromHtml,
    extractReadableLinks,
    extractReadableTextFromHtml,
    isMarkdownContentType,
    isMarkdownPath,
    logReadabilityFallback,
    looksLikeHtml,
    normalizeText,
    parseReadabilityArticle
} from './extraction.js';

// Pagination
import { paginateContent } from './pagination.js';

export interface PrimaryFetchContext {
    url: string;
    parsedUrl: URL;
    targetMaxChars: number;
    startIndex: number;
    response: AxiosResponse;
    finalUrl: string;
    contentType: string;
    raw: string;
    usedBrowserCookies: boolean;
    retrievalMethod: FetchWebContentResult['retrievalMethod'];
    httpErrorStatus?: number;
    withinCookieBudget: <T>(action: (signal?: AbortSignal) => Promise<T>, label: string) => Promise<T>;
    withinBrowserBudget: <T>(action: (signal?: AbortSignal) => Promise<T>, label: string) => Promise<T>;
}

export interface ExtractedHtmlStage {
    finalUrl: string;
    contentType: string;
    raw: string;
    retrievalMethod: FetchWebContentResult['retrievalMethod'];
    title: string;
    extractedContent: string;
    readabilityApplied: boolean;
    degradedNotices: string[];
    readableHtml?: string;
    links?: ExtractedLink[];
    byline?: string;
    excerpt?: string;
    siteName?: string;
}

/**
 * 阶段 1：校验与主请求 (URL 安全检查、HEAD 预检、GET 主请求与 Cookie 自动重试)
 */
export async function validateAndFetchPrimary(
    url: string,
    maxChars: number,
    options: FetchWebContentOptions,
    signal: AbortSignal
): Promise<PrimaryFetchContext> {
    const parsedUrl = new URL(url);
    await assertPublicHttpUrlResolved(parsedUrl, 'Request URL');

    const withinCookieBudget = createBrowserBudget('fetchWebContent cookie', FETCH_WEB_COOKIE_BUDGET_MS, signal);
    const withinBrowserBudget = createBrowserBudget('fetchWebContent render', FETCH_WEB_BROWSER_BUDGET_MS, signal);
    const startIndex = Math.max(0, Math.floor(options.startIndex ?? 0));
    const targetMaxChars = clampMaxChars(maxChars);

    // Pre-flight check to avoid downloading oversized payloads when Content-Length is present.
    // 明显的小文件（.md/.txt/.json 等）跳过 HEAD 预检：HEAD 一次延迟翻倍，
    // 这些类型超 2MB 上限的概率极低，且部分站点禁 HEAD 会白等超时。
    // GET 请求自带 maxBodyLength 硬上限兜底（见 buildRequestOptions）。
    if (!isLikelySmallFile(parsedUrl)) {
        try {
            const headResponse = await requestDirectFirst('HEAD', parsedUrl.toString(), (forceDirect) => ({
                ...buildRequestOptions(undefined, forceDirect, signal),
                responseType: 'json',
                validateStatus: (status: number) => status >= 200 && status < 400
            }), 'Request URL');
            const headContentType = String(headResponse.headers['content-type'] || '').toLowerCase();
            const isPdfPreflight = headContentType.includes('application/pdf') || parsedUrl.pathname.toLowerCase().endsWith('.pdf');
            const maxAllowedBytes = isPdfPreflight ? MAX_PDF_DOWNLOAD_BYTES : MAX_DOWNLOAD_BYTES;
            const headLength = Number(headResponse.headers['content-length']);
            if (Number.isFinite(headLength) && headLength > maxAllowedBytes) {
                throw new AppError({
                    code: 'response_too_large',
                    retryable: false,
                    details: { legacyCode: 'ERR_RESPONSE_TOO_LARGE' },
                    message: `Response body too large (${headLength} bytes). Max allowed is ${maxAllowedBytes} bytes`
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
            void error;
        }
    }

    let response: AxiosResponse;
    let usedBrowserCookies = false;
    let retrievalMethod: FetchWebContentResult['retrievalMethod'] = 'request';
    let httpErrorStatus: number | undefined;

    try {
        const isPdfTarget = parsedUrl.pathname.toLowerCase().endsWith('.pdf');
        const maxDownloadBytes = isPdfTarget ? MAX_PDF_DOWNLOAD_BYTES : MAX_DOWNLOAD_BYTES;
        response = await requestDirectFirst('GET', parsedUrl.toString(), (forceDirect) => buildRequestOptions(undefined, forceDirect, signal, maxDownloadBytes), 'Request URL');
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

    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    const finalUrl = response.request?.res?.responseUrl || parsedUrl.toString();
    assertPublicHttpUrl(finalUrl, 'Final URL');
    const raw = decodeRawResponse(response, contentType);

    return {
        url,
        parsedUrl,
        targetMaxChars,
        startIndex,
        response,
        finalUrl,
        contentType,
        raw,
        usedBrowserCookies,
        retrievalMethod,
        httpErrorStatus,
        withinCookieBudget,
        withinBrowserBudget
    };
}

/**
 * 阶段 2：PDF 处理 (自动检测 PDF 响应、分页切片并返回)
 */
export async function tryHandlePdfFetch(
    primary: PrimaryFetchContext,
    options: FetchWebContentOptions
): Promise<FetchWebContentResult | null> {
    const isPdf = isPdfResponse(primary.contentType, primary.response.data, primary.finalUrl) || primary.raw.startsWith('%PDF-');
    if (!isPdf) {
        return null;
    }

    let pdfBytes: Uint8Array;
    if (primary.response.data instanceof Uint8Array) {
        pdfBytes = new Uint8Array(primary.response.data.buffer, primary.response.data.byteOffset, primary.response.data.byteLength);
    } else if (primary.response.data instanceof ArrayBuffer) {
        pdfBytes = new Uint8Array(primary.response.data);
    } else if (typeof primary.response.data === 'string') {
        pdfBytes = new Uint8Array(Buffer.from(primary.response.data, 'binary'));
    } else {
        pdfBytes = new Uint8Array(Buffer.from(String(primary.response.data)));
    }

    let pdfResult;
    try {
        pdfResult = await extractPdfText(pdfBytes, { url: primary.finalUrl });
        metrics.recordPdfAttempt(true);
    } catch (pdfErr) {
        metrics.recordPdfAttempt(false);
        throw pdfErr;
    }

    const pdfTitle = pdfResult.title || (path.basename(primary.parsedUrl.pathname).replace(/\.pdf$/i, '') || 'PDF Document');
    const fullPdfText = pdfResult.text;

    const paginated = paginateContent(fullPdfText, {
        startIndex: primary.startIndex,
        maxChars: primary.targetMaxChars,
        focus: options.focus,
        appendTruncationMarker: false,
        generateToc: true
    });

    return {
        url: primary.url,
        finalUrl: primary.finalUrl,
        contentType: 'application/pdf',
        title: pdfTitle,
        retrievalMethod: primary.retrievalMethod,
        truncated: paginated.truncated,
        content: paginated.content,
        totalLength: paginated.totalLength,
        startIndex: paginated.startIndex,
        ...(paginated.hasMore ? { hasMore: true, nextStartIndex: paginated.nextStartIndex } : {}),
        pdfPages: pdfResult.totalPages,
        ...(paginated.toc && paginated.toc.length > 0 ? { toc: paginated.toc } : {}),
        ...(paginated.focused ? { focused: true, focusMatchOffset: paginated.focusMatchOffset } : {})
    };
}

/**
 * 阶段 3：HTML / 浏览器阶段 (LLM Markdown、无头浏览器兜底、站点提纯与 Readability 提取)
 */
export async function fetchAndExtractHtmlWithBrowserFallback(
    primary: PrimaryFetchContext,
    options: FetchWebContentOptions,
    signal: AbortSignal
): Promise<ExtractedHtmlStage> {
    let response = primary.response;
    let usedBrowserCookies = primary.usedBrowserCookies;
    let retrievalMethod = primary.retrievalMethod;
    let contentType = primary.contentType;
    let finalUrl = primary.finalUrl;
    let raw = primary.raw;

    if (!usedBrowserCookies && looksLikeBotChallengePage(raw)) {
        let cookieRetry: { response?: AxiosResponse; usedBrowserCookies: boolean };
        try {
            cookieRetry = await primary.withinCookieBudget((stageSignal) => tryRequestWithBrowserCookies(primary.parsedUrl.toString(), stageSignal), 'challenge cookie retry');
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
            finalUrl = response.request?.res?.responseUrl || primary.parsedUrl.toString();
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

    if (options.raw) {
        extractedContent = normalizeText(raw);
    } else {
        if (isMarkdownPath(finalParsedUrl)) {
            extractedContent = normalizeText(raw);
        } else if (contentType.includes('text/html') || looksLikeHtml(raw)) {
            htmlExtraction = extractMainTextFromHtml(raw);
            title = htmlExtraction.title;
            extractedContent = htmlExtraction.text;

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
                browserResult = await primary.withinBrowserBudget((stageSignal) => fetchHtmlViaBrowser(primary.parsedUrl.toString(), stageSignal), 'browser html fallback');
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
            ? purifySiteContent(finalUrl || primary.parsedUrl.toString(), raw)
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
                const article = await parseReadabilityArticle(raw, finalUrl);
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

    return {
        finalUrl,
        contentType,
        raw,
        retrievalMethod,
        title,
        extractedContent,
        readabilityApplied,
        degradedNotices,
        readableHtml,
        links,
        byline,
        excerpt,
        siteName
    };
}

/**
 * 阶段 4：回退与门禁校验 (反爬拦截判定、Soft 404 检测、空正文兜底)
 */
export function validateFetchOutcome(
    primary: PrimaryFetchContext,
    stage: ExtractedHtmlStage,
    options: FetchWebContentOptions
): void {
    if (!options.raw) {
        const isHtml = stage.contentType.includes('text/html') || looksLikeHtml(stage.raw);
        const isPleaseWait = /please\s+wait/i.test(stage.extractedContent) || /just\s+a\s+moment/i.test(stage.extractedContent);
        const isSuspiciousShortEmpty = isHtml && stage.extractedContent.length < 50 && (!stage.title || stage.title.trim().length === 0);
        const titleHit = Boolean(stage.title) && looksLikeBotChallengePage(stage.title);
        const botDetected = titleHit
            || isPleaseWait
            || isSuspiciousShortEmpty
            || looksLikeBotChallengePage(stage.raw)
            || looksLikeBotChallengePage(stage.extractedContent);
        if (titleHit || isPleaseWait || isSuspiciousShortEmpty || (botDetected && stage.extractedContent.length < 350)) {
            throw new AppError({
                code: 'bot_challenge',
                retryable: false,
                status: primary.httpErrorStatus || 403,
                details: { legacyCode: 'ERR_BOT_CHALLENGE' },
                message: '目标站点触发反爬验证或需要登录（命中反爬拦截特征），未能获取有效正文内容。'
            });
        }

        if (stage.extractedContent.length < 350) {
            const isSoft404 =
                /(?:^|[\s_-])404(?:\s+not\s+found)?(?:[\s_-]|$)|页面找不到了|文章不存在|该内容已被删除|你似乎来到了没有知识存在的荒原/i.test(stage.title || '') ||
                /(?:^|[\s_-])404\s+not\s+found|页面不存在或已删除|文章不存在或已被删除/i.test(stage.extractedContent);
            if (isSoft404) {
                throw new AppError({
                    code: 'not_found',
                    retryable: false,
                    status: 404,
                    details: { legacyCode: 'ERR_PAGE_NOT_FOUND' },
                    message: `目标页面不存在或已被删除 (404 / soft 404): ${primary.parsedUrl.toString()}`
                });
            }
        }
    }

    if (!stage.extractedContent) {
        if (primary.httpErrorStatus !== undefined) {
            throw new AppError({
                code: primary.httpErrorStatus === 429 ? 'rate_limited' : 'network_error',
                retryable: true,
                status: primary.httpErrorStatus,
                message: `Request failed with HTTP ${primary.httpErrorStatus} and no readable content was extracted (${primary.parsedUrl.toString()})`
            });
        }
        throw new AppError({
            code: 'empty_content',
            retryable: false,
            message: 'No readable content was extracted from this URL'
        });
    }
}

/**
 * 阶段 5：响应组装 (正文分页/聚焦切片、TOC 生成与结果信封组装)
 */
export function assembleFetchResult(
    primary: PrimaryFetchContext,
    stage: ExtractedHtmlStage,
    options: FetchWebContentOptions
): FetchWebContentResult {
    const paginated = paginateContent(stage.extractedContent, {
        startIndex: primary.startIndex,
        maxChars: primary.targetMaxChars,
        focus: options.focus,
        appendTruncationMarker: true,
        generateToc: !options.raw
    });

    return {
        url: primary.parsedUrl.toString(),
        finalUrl: stage.finalUrl,
        contentType: stage.contentType || 'unknown',
        title: stage.title,
        retrievalMethod: stage.retrievalMethod,
        truncated: paginated.truncated,
        content: paginated.content,
        ...(options.raw ? { raw: stage.raw } : {}),
        totalLength: paginated.totalLength,
        startIndex: paginated.startIndex,
        ...(paginated.hasMore ? { hasMore: true, nextStartIndex: paginated.nextStartIndex } : {}),
        ...(options.readability ? { readabilityApplied: stage.readabilityApplied } : {}),
        ...(stage.degradedNotices.length > 0 ? { degraded: stage.degradedNotices } : {}),
        ...(options.includeReadableHtml && stage.readableHtml ? { readableHtml: stage.readableHtml } : {}),
        ...(options.format === 'markdown' ? { format: 'markdown' as const } : {}),
        ...(stage.links ? { links: stage.links } : {}),
        ...(stage.byline ? { byline: stage.byline } : {}),
        ...(stage.excerpt ? { excerpt: stage.excerpt } : {}),
        ...(stage.siteName ? { siteName: stage.siteName } : {}),
        ...(paginated.toc && paginated.toc.length > 0 ? { toc: paginated.toc } : {}),
        ...(paginated.focused ? { focused: true, focusMatchOffset: paginated.focusMatchOffset } : {})
    };
}
