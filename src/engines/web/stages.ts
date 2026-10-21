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
import { extractWithSchema, pickExtractionHtml, type ExtractResult } from './extract.js';
import { scopeHtmlToSelector } from '../../utils/htmlScope.js';

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
    /** CSS schema 结构化提取结果（仅在请求了 extract 且拿到 HTML 时存在） */
    extraction?: ExtractResult;
    /** selector 收窄生效时的回显 */
    scoped?: { selector: string; matched: number };
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

    // 不再做 HEAD 预检：它对每个页面都多一个 RTT（国内 30-80ms、海外 200-600ms），
    // 而它的两个目的在 GET 上都已经有等价兜底：
    //   - 大小上限 → buildRequestOptions 的 maxBodyLength/maxContentLength 硬中断
    //   - PDF 判定 → GET 响应上的 isPdfResponse()，以及下面按 .pdf 路径选 20MB 上限
    // 已知取舍：非 .pdf 路径提供的大 PDF（>2MB）会先撞 2MB 上限；这类 URL 极少，
    // 且相比「每个页面都白花一个 RTT」，这个代价更划算。

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

    if (options.selector) {
        throw new AppError({
            code: 'extraction_failed',
            retryable: false,
            message: `selector requires an HTML page, but this target is a PDF (${primary.finalUrl})`
        });
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
        focusMode: options.focusMode,
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
        ...(paginated.focused ? { focused: true, focusMatchOffset: paginated.focusMatchOffset } : {}),
        ...(paginated.focusMode ? { focusMode: paginated.focusMode } : {}),
        ...(paginated.focusBlocks ? { focusBlocks: paginated.focusBlocks } : {})
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
    let sitePurifiedHtml: string | undefined;
    let scoped: { selector: string; matched: number } | undefined;
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

        // 选择器收窄：在浏览器兜底之后、所有正文提取之前执行，
        // 这样 Readability / 站点提纯 / markdown 转换全部只作用于命中子树。
        // 未命中会抛 selector_not_found（带候选），绝不静默回退全页。
        if (options.selector) {
            if (!(contentType.includes('text/html') || looksLikeHtml(raw))) {
                throw new AppError({
                    code: 'extraction_failed',
                    retryable: false,
                    message: `selector requires an HTML page, but this target returned ${contentType || 'a non-HTML body'}`
                });
            }
            const scopeResult = scopeHtmlToSelector(raw, options.selector);
            raw = scopeResult.html;
            scoped = { selector: options.selector, matched: scopeResult.matched };

            // 子树变了，容器提取要重跑；标题保留整页的（子树里通常没有 <title>）
            const scopedExtraction = extractMainTextFromHtml(raw);
            htmlExtraction = scopedExtraction;
            extractedContent = scopedExtraction.text;
            if (!title && scopedExtraction.title) {
                title = scopedExtraction.title;
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
            sitePurifiedHtml = sitePurified.html;
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

    // 结构化提取：在正文提取之后、分页之前执行。
    // 用原始页面 DOM 而不是 Readability 的 DOM —— 用户写 selector 时参考的是真实页面结构。
    let extraction: ExtractResult | undefined;
    if (options.extract) {
        const html = pickExtractionHtml({
            raw,
            sitePurifiedHtml,
            readableHtml,
            containerHtml: htmlExtraction?.html
        });
        if (!html) {
            throw new AppError({
                code: 'extraction_failed',
                retryable: false,
                message: 'extract requires an HTML page, but this target returned Markdown, plain text, or a PDF'
            });
        }
        extraction = extractWithSchema(html, options.extract);
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
        siteName,
        ...(extraction ? { extraction } : {}),
        ...(scoped ? { scoped } : {})
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

    // 结构化提取成功时，正文提取为空是正常的（页面正文可能全是 JS 渲染，
    // 而目标数据在静态 DOM 里）——此时应把 JSON 交给调用方，而不是报 empty_content
    if (!stage.extractedContent && !stage.extraction) {
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
    // 结构化提取命中时直接返回 JSON，跳过 paginateContent：
    // 对数组/对象做字符切片只会产出无法解析的 JSON。
    if (stage.extraction) {
        const json = JSON.stringify(stage.extraction.items, null, 2);
        return {
            url: primary.parsedUrl.toString(),
            finalUrl: stage.finalUrl,
            contentType: 'application/json',
            title: stage.title,
            retrievalMethod: stage.retrievalMethod,
            truncated: false,
            content: json,
            totalLength: json.length,
            startIndex: 0,
            format: 'json',
            extracted: stage.extraction.items,
            extraction: {
                count: stage.extraction.count,
                matchedBase: stage.extraction.matchedBase,
                ...(options.extract?.baseSelector ? { baseSelector: options.extract.baseSelector } : {})
            },
            ...(stage.scoped ? { scoped: stage.scoped } : {}),
            ...(stage.degradedNotices.length > 0 ? { degraded: stage.degradedNotices } : {}),
            ...(stage.siteName ? { siteName: stage.siteName } : {}),
            ...(stage.byline ? { byline: stage.byline } : {})
        };
    }

    const paginated = paginateContent(stage.extractedContent, {
        startIndex: primary.startIndex,
        maxChars: primary.targetMaxChars,
        focus: options.focus,
        focusMode: options.focusMode,
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
        ...(options.format === 'markdown' ? { format: 'markdown' as const } : {}),
        ...(stage.links ? { links: stage.links } : {}),
        ...(stage.byline ? { byline: stage.byline } : {}),
        ...(stage.excerpt ? { excerpt: stage.excerpt } : {}),
        ...(stage.siteName ? { siteName: stage.siteName } : {}),
        ...(paginated.toc && paginated.toc.length > 0 ? { toc: paginated.toc } : {}),
        ...(paginated.focused ? { focused: true, focusMatchOffset: paginated.focusMatchOffset } : {}),
        ...(paginated.focusMode ? { focusMode: paginated.focusMode } : {}),
        ...(paginated.focusBlocks ? { focusBlocks: paginated.focusBlocks } : {}),
        ...(stage.scoped ? { scoped: stage.scoped } : {})
    };
}
