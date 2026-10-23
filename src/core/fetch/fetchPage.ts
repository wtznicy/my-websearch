import { FetchWebContentOptions, FetchWebContentResult, generateMarkdownToc, fetchWebContent } from '../../engines/web/fetchWebContent.js';
import type { ExtractSchema } from '../../engines/web/extract.js';
import type { FocusMode } from '../../engines/web/types.js';
import type { LinkRetentionMode } from '../../utils/linkRetention.js';
import { sliceMarkdownContent } from '../../engines/web/pagination.js';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../validation/targetValidation.js';
import { AppError } from '../errors.js';
import { ensureSystemProxyDetected } from '../../utils/systemProxy.js';
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
    focusMode?: FocusMode;
    /** 把正文行内链接改写成编号引用 + References 列表 */
    citations?: boolean;
    /** 行内链接保留策略（all/text/none）；与 citations 互斥 */
    retainLinks?: LinkRetentionMode;
    /** CSS 选择器收窄：只提取命中子树（与 extract、raw 互斥） */
    selector?: string;
    /** CSS schema 结构化提取（命中时返回 JSON，跳过缓存与分页） */
    extract?: ExtractSchema;
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
 * 跨字段校验。放在管线入口而不是各个 adapter 里，
 * 这样 MCP / CLI / daemon 三条路径的行为自动一致。
 */
function validateFetchOptionCombinations(params: FetchPipelineOptions): void {
    if (params.selector && params.extract) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: 'selector cannot be combined with extract',
            hint: 'selector returns scoped markdown (keeps code blocks and tables); extract returns JSON via its own baseSelector. Pick one.'
        });
    }
    if (params.selector && params.raw) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: 'selector cannot be combined with raw',
            hint: 'raw returns the response body untouched, so there is nothing to scope.'
        });
    }
    if (params.citations && params.retainLinks && params.retainLinks !== 'all') {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: `citations cannot be combined with retainLinks "${params.retainLinks}"`,
            hint: 'citations needs the URLs it is supposed to list; retainLinks "text"/"none" strips them.'
        });
    }
}

/** 整体抓取预算：cookie 15s + 浏览器 30s + 主请求 10s + 回退 10s 各自为政时最坏 ~65s，会打穿 MCP 客户端默认超时 */
const FETCH_PIPELINE_DEADLINE_MS = (() => {
    const parsed = Number(process.env.FETCH_WEB_DEADLINE_MS);
    return Number.isFinite(parsed) && parsed >= 5000 ? Math.floor(parsed) : 45_000;
})();

/**
 * 把调用方 signal 与整体 deadline 合并成一个 signal。
 * 定时器 unref：请求提前返回时不会因为它把进程挂住。
 */
export function combineWithDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const controller = new AbortController();
    if (signal) {
        if (signal.aborted) {
            controller.abort(signal.reason);
        } else {
            signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
        }
    }
    const timer = setTimeout(() => {
        controller.abort(new AppError({
            code: 'network_timeout',
            retryable: true,
            message: `fetch pipeline exceeded ${timeoutMs}ms deadline`
        }));
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    return controller.signal;
}

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
        focusMode,
        citations,
        retainLinks,
        selector,
        extract,
        signal,
        requestContext
    } = params;

    validateFetchOptionCombinations(params);

    // 预热系统代理检测：抓取路径的代理兜底是同步读取缓存，不预热会首发直连
    await ensureSystemProxyDetected();

    // P1-13：整条抓取管线共用同一个 deadline（默认 45s，FETCH_WEB_DEADLINE_MS 可调），
    // 避免 cookie/浏览器/主请求/代理回退四段预算叠加到 ~65s 打穿 MCP 客户端超时。
    const pipelineSignal = combineWithDeadline(signal, FETCH_PIPELINE_DEADLINE_MS);

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
    // 缓存是加速器，不是成功路径的一部分：写失败（磁盘满 / SQLITE_BUSY / 权限）不能让已抓到的正文陪葬
    const safeCacheSet = (...args: Parameters<typeof pageCache.set>): void => {
        try {
            pageCache.set(...args);
        } catch (error) {
            console.warn('[fetchPage] cache write failed (ignored):', error instanceof Error ? error.message : String(error));
        }
    };
    const effectiveFormat = format ?? 'markdown';
    // 结构化提取需要 HTML，而缓存里只有 Markdown —— 因此 extract 请求既不读缓存也不写缓存。
    // readability / includeLinks / selector 同理：缓存键只有 (url, format)，不含这些「提取方式」开关，
    // 命中缓存会返回另一种提取方式的正文（并丢掉 links / scoped 等元数据），因此一并绕过缓存。
    // retainLinks / focus / citations 是**切片之后**的纯变换，不受影响，仍可走缓存。
    const cacheEligible = cacheMode !== 'reload'
        && !raw
        && !extract
        && !readability
        && !includeLinks
        && !selector;

    // Step 2 & 3: 磁盘级 Markdown 缓存检查（非 reload 模式生效）
    if (cacheEligible) {
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
                const sliced = sliceMarkdownContent(cachedRecord.markdown, {
                    url,
                    finalUrl: cachedRecord.normalizedUrl || url,
                    title: cachedRecord.title,
                    siteName: cachedRecord.siteName,
                    contentType: cachedRecord.isPdf ? 'application/pdf' : 'text/markdown',
                    startIndex,
                    maxChars,
                    focus,
                    focusMode,
                    citations,
                    retainLinks,
                    cached: true,
                    warnings,
                    pdfPages: cachedRecord.pdfPages
                });
                return cachedRecord.publishedAt ? { ...sliced, publishedAt: cachedRecord.publishedAt } : sliced;
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
                        ...buildAxiosRequestOptions({ headers, forceDirect, signal: pipelineSignal, timeout: 3500 }),
                        validateStatus: (status: number) => status === 304 || (status >= 200 && status < 400)
                    }), 'Conditional 304 check');

                    if (check304.status === 304) {
                        pageCache.renew(url, effectiveFormat);
                        metrics.recordFetchCacheHit();
                        const sliced = sliceMarkdownContent(cachedRecord.markdown, {
                            url,
                            finalUrl: cachedRecord.normalizedUrl || url,
                            title: cachedRecord.title,
                            siteName: cachedRecord.siteName,
                            contentType: cachedRecord.isPdf ? 'application/pdf' : 'text/markdown',
                            startIndex,
                            maxChars,
                            focus,
                            focusMode,
                            citations,
                            retainLinks,
                            cached: true,
                            warnings,
                            pdfPages: cachedRecord.pdfPages
                        });
                        return cachedRecord.publishedAt ? { ...sliced, publishedAt: cachedRecord.publishedAt } : sliced;
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
    // 上游提取阶段的元数据需要一路带到最终切片结果，否则会被 sliceMarkdownContent 重建时丢掉
    let delegateLinks: FetchWebContentResult['links'];
    let delegateByline: string | undefined;
    let delegateExcerpt: string | undefined;
    let delegateReadabilityApplied: boolean | undefined;
    let delegateDegraded: string[] | undefined;
    let delegateScoped: FetchWebContentResult['scoped'];
    let delegatePublishedAt: string | undefined;

    // 专有站点内部转发（CSDN / 掘金 / GitHub / Stack Overflow）
    // 请求了 extract 时跳过这些转发：它们只产出文本/Markdown，拿不到可选择的 HTML DOM
    if (!raw && !extract) {
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
                    safeCacheSet(url, '', effectiveFormat, { isNotFound: true, ttlMs: 60 * 1000 });
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
                ...(extract ? { extract } : {}),
                ...(selector ? { selector } : {}),
                signal: pipelineSignal
            });

            fullMarkdown = fetchResult.content;
            pageTitle = fetchResult.title;
            siteName = fetchResult.siteName;
            finalUrl = fetchResult.finalUrl || url;
            isPdf = fetchResult.contentType.includes('application/pdf');
            pdfPages = fetchResult.pdfPages;
            delegateLinks = fetchResult.links;
            delegateByline = fetchResult.byline;
            delegateExcerpt = fetchResult.excerpt;
            delegateReadabilityApplied = fetchResult.readabilityApplied;
            delegateDegraded = fetchResult.degraded;
            delegateScoped = fetchResult.scoped;
            delegatePublishedAt = fetchResult.publishedAt;
            // P0-2：条件请求所需的验证器必须从上游响应带回来，
            // 否则缓存记录里 etag / lastModified 恒为 null，304 续期分支永远不可达。
            etag = fetchResult.etag;
            lastModified = fetchResult.lastModified;
            // 引擎侧产生的 warning（例如 focus 未命中的说明）必须一路上浮，否则调用方永远看不到
            if (fetchResult.warnings && fetchResult.warnings.length > 0) {
                warnings.push(...fetchResult.warnings);
            }

            // 结构化提取结果已是最终形态：不再切片/分页，也不写缓存
            if (fetchResult.extracted !== undefined) {
                return {
                    ...fetchResult,
                    warnings: [...new Set([...(fetchResult.warnings ?? []), ...warnings])]
                };
            }
        } catch (fetchError) {
            if (fetchError instanceof AppError && fetchError.code === 'not_found') {
                safeCacheSet(url, '', effectiveFormat, { isNotFound: true, ttlMs: 60 * 1000 });
            }
            throw fetchError;
        }
    }

    // Step 5: 质量门禁与回写缓存（深拷贝存储）
    if (cacheEligible && fullMarkdown && passesQualityGate(fullMarkdown, pageTitle)) {
        safeCacheSet(url, fullMarkdown, effectiveFormat, {
            title: pageTitle,
            siteName,
            etag,
            lastModified,
            ...(delegatePublishedAt ? { publishedAt: delegatePublishedAt } : {}),
            isPdf,
            pdfPages
        });
    }

    // Step 6: 统一分页与切片返回
    const sliced = sliceMarkdownContent(fullMarkdown, {
        url,
        finalUrl,
        title: pageTitle,
        siteName,
        contentType: isPdf ? 'application/pdf' : 'text/markdown',
        startIndex,
        maxChars,
        focus,
        focusMode,
        citations,
        retainLinks,
        cached: false,
        warnings,
        pdfPages,
        ...(delegateLinks ? { links: delegateLinks } : {}),
        ...(delegateByline ? { byline: delegateByline } : {}),
        ...(delegateExcerpt ? { excerpt: delegateExcerpt } : {}),
        ...(delegateReadabilityApplied !== undefined ? { readabilityApplied: delegateReadabilityApplied } : {}),
        ...(delegateDegraded ? { degraded: delegateDegraded } : {}),
        ...(delegateScoped ? { scoped: delegateScoped } : {})
    });
    return delegatePublishedAt ? { ...sliced, publishedAt: delegatePublishedAt } : sliced;
}
