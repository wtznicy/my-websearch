import { FetchWebContentOptions, FetchWebContentResult } from '../../engines/web/fetchWebContent.js';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../validation/targetValidation.js';
import { AppError } from '../errors.js';

export type ArticleFetchOptions = { format?: 'text' | 'markdown' };
export type ArticleFetcher = (url: string, options?: ArticleFetchOptions) => Promise<{ content: string }>;
export type GithubReadmeFetcher = (url: string) => Promise<string | null>;
export type WebFetcher = (url: string, maxChars: number, options?: FetchWebContentOptions) => Promise<FetchWebContentResult>;

export function createArticleFetchService(
    type: 'csdn' | 'juejin',
    fetcher: ArticleFetcher
) {
    return {
        async execute({ url, format }: { url: string; format?: ArticleFetchOptions['format'] }): Promise<{ content: string }> {
            if (!validateArticleUrl(url, type)) {
                throw new AppError({
                    code: 'invalid_arguments',
                    retryable: false,
                    engine: type,
                    message: `Invalid ${type} article URL`
                });
            }

            // format 目前仅掘金实现（markdown 保留代码围栏与表格）；CSDN 忽略该参数
            return fetcher(url, { format });
        }
    };
}

export function createGithubReadmeService(fetcher: GithubReadmeFetcher) {
    return {
        async execute({ url }: { url: string }): Promise<string | null> {
            if (!validateGithubRepositoryUrl(url)) {
                throw new AppError({
                    code: 'invalid_arguments',
                    retryable: false,
                    engine: 'github',
                    message: 'Invalid GitHub repository URL'
                });
            }

            return fetcher(url);
        }
    };
}

export function createWebFetchService(
    fetcher: WebFetcher,
    options?: {
        fetchCsdn?: ArticleFetcher;
        fetchJuejin?: ArticleFetcher;
    }
) {
    return {
        async execute({
            url,
            maxChars,
            readability,
            includeLinks,
            raw,
            startIndex,
            format
        }: {
            url: string;
            maxChars: number;
            readability?: boolean;
            includeLinks?: boolean;
            raw?: boolean;
            startIndex?: number;
            format?: 'text' | 'markdown';
        }): Promise<FetchWebContentResult> {
            if (!validatePublicWebUrl(url)) {
                throw new AppError({
                    code: 'invalid_arguments',
                    retryable: false,
                    message: 'Invalid public HTTP(S) URL'
                });
            }

            // 专用站点内部转发（非 raw 模式生效）：
            // 命中 CSDN/掘金文章时，自动内部转发给专用文章提取器，获得高保真代码排版与广告剥离
            if (!raw) {
                try {
                    const parsed = new URL(url);
                    const offset = startIndex ?? 0;

                    if (options?.fetchCsdn && parsed.hostname === 'blog.csdn.net' && /^\/[^/]+\/article\/details\/\d+/.test(parsed.pathname)) {
                        const article = await options.fetchCsdn(url, { format });
                        const fullText = article.content;
                        const pageContent = fullText.slice(offset, offset + maxChars);
                        const hasMore = fullText.length > offset + maxChars;
                        return {
                            url,
                            finalUrl: url,
                            contentType: 'text/markdown',
                            title: '',
                            retrievalMethod: 'request',
                            truncated: hasMore,
                            content: pageContent,
                            totalLength: fullText.length,
                            startIndex: offset,
                            hasMore,
                            nextStartIndex: hasMore ? offset + maxChars : undefined
                        };
                    }

                    if (options?.fetchJuejin && (parsed.hostname === 'juejin.cn' || parsed.hostname === 'juejin.im') && /^\/post\/\d+/.test(parsed.pathname)) {
                        const article = await options.fetchJuejin(url, { format });
                        const fullText = article.content;
                        const pageContent = fullText.slice(offset, offset + maxChars);
                        const hasMore = fullText.length > offset + maxChars;
                        return {
                            url,
                            finalUrl: url,
                            contentType: 'text/markdown',
                            title: '',
                            retrievalMethod: 'request',
                            truncated: hasMore,
                            content: pageContent,
                            totalLength: fullText.length,
                            startIndex: offset,
                            hasMore,
                            nextStartIndex: hasMore ? offset + maxChars : undefined
                        };
                    }
                } catch {
                    // 若专有抓取器异常，平滑回退到通用 fetcher
                }
            }

            return fetcher(url, maxChars, { readability, includeLinks, raw, startIndex, format });
        }
    };
}
