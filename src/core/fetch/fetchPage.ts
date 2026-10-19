import {
    FetchWebContentOptions,
    FetchWebContentResult,
    generateMarkdownToc,
    fetchWebContent
} from '../../engines/web/fetchWebContent.js';
import { sliceMarkdownContent } from '../../engines/web/pagination.js';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../validation/targetValidation.js';
import { AppError } from '../errors.js';
import { isStackOverflowQuestionUrl, fetchStackOverflowQuestion } from '../../engines/stackoverflow/fetchStackOverflow.js';
import { getGlobalPageCache, PageCacheRecord, passesQualityGate } from './pageCache.js';
import { metrics } from '../metrics.js';
import { RequestContext } from '../requestContext.js';
import { requestDirectFirst, buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';

export type ArticleFetchOptions = { format?: 'text' | 'markdown' };
export type ArticleFetcher = (url: string, options?: ArticleFetchOptions) => Promise<{ content: string; title?: string }>;
export type GithubReadmeFetcher = (url: string) => Promise<string | null>;
export type StackOverflowQuestionFetcher = (url: string) => Promise<{ title: string; content: string } | null>;
export type WebFetcher = (url: string, maxChars: number, options?: FetchWebContentOptions) => Promise<FetchWebContentResult>;

export interface FetchPipelineOptions {
    url: string;
    maxChars: number;
    cache?: 'default' | 'reload';
    readability?: boolean;
    includeLinks?: boolean;
    raw?: boolean;
    startIndex?: number;
    format?: 'text' | 'markdown';
    focus?: string;
    signal?: AbortSignal;
    requestContext?: RequestContext;
}

export interface DedicatedFetchers {
    fetchCsdn?: ArticleFetcher;
    fetchJuejin?: ArticleFetcher;
    fetchGithub?: GithubReadmeFetcher;
    fetchStackOverflow?: StackOverflowQuestionFetcher;
    genericFetcher?: WebFetcher;
}

export { sliceMarkdownContent };

/**
 * 单一 FetchPolicy 执行管线：
 * 校验 → 缓存 → 条件请求（304） → 重定向/SSRF → 解码 → 提取 → 质量门禁 → 回写缓存 → 分页切片
 */
export async function executeFetchPipeline(
    params: FetchPipelineOptions,
    fetchers: DedicatedFetchers = {}
): Promise<FetchWebContentResult> {
    const {
        url,
        maxChars,
        cache: cacheMode = 'default',
        readability,
        includeLinks,
        raw,
        startIndex,
        format = 'markdown',
        focus,
        signal,
        requestContext
    } = params;

    const warnings: string[] = requestContext?.warnings ? [...requestContext.warnings] : [];

    // Step 1: URL 格式与公网校验
    if (!validatePublicWebUrl(url)) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: 'Invalid public HTTP(S) URL'
        });
    }

    const pageCache = getGlobalPageCache();
    const effectiveFormat = format ?? 'markdown';

    // Step 2 & 3: 磁盘级 Markdown 缓存检查（非 reload 模式生效）
    if (cacheMode !== 'reload' && !raw) {
        const cachedRecord = pageCache.get(url, effectiveFormat);
        if (cachedRecord) {
            // 负缓存命中（404 记录）
            if (cachedRecord.isNotFound) {
                if (!pageCache.isExpired(cachedRecord)) {
                    metrics.recordFetchCacheHit();
                    throw new AppError({
                        code: 'not_found',
                        retryable: false,
                        message: `Target URL returned 404 (cached for ${Math.max(1, Math.round((cachedRecord.expiresAt - Date.now()) / 1000))}s)`
                    });
                }
            } else if (!pageCache.isExpired(cachedRecord)) {
                // 正向缓存命中 (<50ms 纯切片返回)
                metrics.recordFetchCacheHit();
                return sliceMarkdownContent(cachedRecord.markdown, {
                    url,
                    finalUrl: cachedRecord.normalizedUrl || url,
                    title: cachedRecord.title,
                    siteName: cachedRecord.siteName,
                    contentType: cachedRecord.isPdf ? 'application/pdf' : 'text/markdown',
                    startIndex,
                    maxChars,
                    focus,
                    cached: true,
                    warnings,
                    pdfPages: cachedRecord.pdfPages
                });
            } else if (cachedRecord.etag || cachedRecord.lastModified) {
                // 已过期但具备 ETag / Last-Modified：发起轻量条件请求（304 探测）
                try {
                    const headers: Record<string, string> = {
                        'User-Agent': DEFAULT_DESKTOP_UA
                    };
                    if (cachedRecord.etag) {
                        headers['If-None-Match'] = cachedRecord.etag;
                    }
                    if (cachedRecord.lastModified) {
                        headers['If-Modified-Since'] = cachedRecord.lastModified;
                    }

                    const check304 = await requestDirectFirst('HEAD', url, (forceDirect) => ({
                        ...buildAxiosRequestOptions({ headers, forceDirect, signal, timeout: 3500 }),
                        validateStatus: (status: number) => status === 304 || (status >= 200 && status < 400)
                    }), 'Conditional 304 check');

                    if (check304.status === 304) {
                        pageCache.renew(url, effectiveFormat);
                        metrics.recordFetchCacheHit();
                        return sliceMarkdownContent(cachedRecord.markdown, {
                            url,
                            finalUrl: cachedRecord.normalizedUrl || url,
                            title: cachedRecord.title,
                            siteName: cachedRecord.siteName,
                            contentType: cachedRecord.isPdf ? 'application/pdf' : 'text/markdown',
                            startIndex,
                            maxChars,
                            focus,
                            cached: true,
                            warnings,
                            pdfPages: cachedRecord.pdfPages
                        });
                    }
                } catch {
                    // 304 探测失败或超时，平滑回退到全量抓取
                }
            }
        }
    }

    // Step 4: 上游抓取
    metrics.recordFetchCacheMiss();

    let fullMarkdown = '';
    let pageTitle = '';
    let siteName: string | undefined;
    let finalUrl = url;
    let etag: string | undefined;
    let lastModified: string | undefined;
    let isPdf = false;
    let pdfPages: number | undefined;

    // 专有站点内部转发（CSDN / 掘金 / GitHub / Stack Overflow）
    if (!raw) {
        try {
            const parsed = new URL(url);

            if (fetchers.fetchCsdn && validateArticleUrl(url, 'csdn')) {
                const article = await fetchers.fetchCsdn(url, { format: effectiveFormat });
                fullMarkdown = article.content;
                pageTitle = article.title || 'CSDN博客';
                siteName = 'CSDN博客';
            } else if (fetchers.fetchJuejin && validateArticleUrl(url, 'juejin')) {
                const article = await fetchers.fetchJuejin(url, { format: effectiveFormat });
                fullMarkdown = article.content;
                pageTitle = article.title || '稀土掘金';
                siteName = '稀土掘金';
            } else if (fetchers.fetchGithub && validateGithubRepositoryUrl(url)) {
                const ghContent = await fetchers.fetchGithub(url);
                if (ghContent) {
                    const isGitee = parsed.hostname.includes('gitee.com');
                    siteName = isGitee ? 'Gitee' : 'GitHub';
                    pageTitle = `${siteName} Content`;
                    fullMarkdown = ghContent;
                }
            } else if (isStackOverflowQuestionUrl(url)) {
                const soFetcher = fetchers.fetchStackOverflow ?? fetchStackOverflowQuestion;
                const soContent = await soFetcher(url);
                if (soContent) {
                    pageTitle = soContent.title;
                    siteName = 'Stack Overflow';
                    fullMarkdown = soContent.content;
                }
            }
        } catch (forwardError) {
            if (
                forwardError instanceof AppError &&
                (forwardError.code === 'not_found' ||
                    forwardError.code === 'start_index_out_of_range' ||
                    forwardError.code === 'bot_challenge')
            ) {
                if (forwardError.code === 'not_found') {
                    pageCache.set(url, '', effectiveFormat, { isNotFound: true, ttlMs: 60 * 1000 });
                }
                throw forwardError;
            }
            // 专有抓取器异常平滑降级至通用 fetcher
        }
    }

    // 若专有抓取器未命中或未产生内容，执行通用抓取器
    if (!fullMarkdown) {
        const genericFetcher = fetchers.genericFetcher || fetchWebContent;
        try {
            // 注意：通用 fetcher 传入足够大的 maxChars 获取正文全文，存入缓存供后续任意切片
            const fetchResult = await genericFetcher(url, 200000, {
                readability,
                includeLinks,
                raw,
                startIndex: 0,
                format: effectiveFormat,
                signal
            });

            fullMarkdown = fetchResult.content;
            pageTitle = fetchResult.title;
            siteName = fetchResult.siteName;
            finalUrl = fetchResult.finalUrl || url;
            isPdf = fetchResult.contentType.includes('application/pdf');
            pdfPages = fetchResult.pdfPages;
        } catch (fetchError) {
            if (fetchError instanceof AppError && fetchError.code === 'not_found') {
                pageCache.set(url, '', effectiveFormat, { isNotFound: true, ttlMs: 60 * 1000 });
            }
            throw fetchError;
        }
    }

    // Step 5: 质量门禁与回写缓存（深拷贝存储）
    if (!raw && fullMarkdown && passesQualityGate(fullMarkdown, pageTitle)) {
        pageCache.set(url, fullMarkdown, effectiveFormat, {
            title: pageTitle,
            siteName,
            etag,
            lastModified,
            isPdf,
            pdfPages
        });
    }

    // Step 6: 统一分页与切片返回
    return sliceMarkdownContent(fullMarkdown, {
        url,
        finalUrl,
        title: pageTitle,
        siteName,
        contentType: isPdf ? 'application/pdf' : 'text/markdown',
        startIndex,
        maxChars,
        focus,
        cached: false,
        warnings,
        pdfPages
    });
}
