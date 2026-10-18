import { FetchWebContentOptions, FetchWebContentResult, generateMarkdownToc } from '../../engines/web/fetchWebContent.js';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../validation/targetValidation.js';
import { AppError } from '../errors.js';
import { isStackOverflowQuestionUrl, fetchStackOverflowQuestion } from '../../engines/stackoverflow/fetchStackOverflow.js';

export type ArticleFetchOptions = { format?: 'text' | 'markdown' };
export type ArticleFetcher = (url: string, options?: ArticleFetchOptions) => Promise<{ content: string; title?: string }>;
export type GithubReadmeFetcher = (url: string) => Promise<string | null>;
export type StackOverflowQuestionFetcher = (url: string) => Promise<{ title: string; content: string } | null>;
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
        fetchGithub?: GithubReadmeFetcher;
        fetchStackOverflow?: StackOverflowQuestionFetcher;
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
            format,
            focus,
            signal
        }: {
            url: string;
            maxChars: number;
            readability?: boolean;
            includeLinks?: boolean;
            raw?: boolean;
            startIndex?: number;
            format?: 'text' | 'markdown';
            focus?: string;
            signal?: AbortSignal;
        }): Promise<FetchWebContentResult> {
            if (!validatePublicWebUrl(url)) {
                throw new AppError({
                    code: 'invalid_arguments',
                    retryable: false,
                    message: 'Invalid public HTTP(S) URL'
                });
            }

            // 专用站点内部转发（非 raw 模式生效）：
            // 命中 CSDN/掘金/GitHub 等特定技术站点时，自动内部转发给专用提取器，获得高保真代码排版与结构化提纯
            if (!raw) {
                try {
                    const parsed = new URL(url);
                    const offset = startIndex ?? 0;

                    const formatMarkdownResult = (
                        fullText: string,
                        articleTitle: string,
                        defaultSiteName: string
                    ): FetchWebContentResult => {
                        let pageContent = '';
                        let hasMore = false;
                        let focused = false;
                        let effectiveOffset = offset;

                        if (focus && focus.trim()) {
                            const focusTerm = focus.trim().toLowerCase();
                            const focusIdx = fullText.toLowerCase().indexOf(focusTerm);
                            if (focusIdx !== -1) {
                                focused = true;
                                const windowSize = 2500;
                                const start = Math.max(0, focusIdx - windowSize);
                                const end = Math.min(fullText.length, focusIdx + focusTerm.length + windowSize);
                                const snippet = fullText.slice(start, end);
                                const prefix = start > 0 ? `[... focused on "${focus}" at offset ${focusIdx}, showing ${start}-${end} of ${fullText.length} ...]\n\n` : '';
                                const suffix = end < fullText.length ? `\n\n[... truncated; continue with startIndex=${end} or specify another focus ...]` : '';
                                pageContent = `${prefix}${snippet}${suffix}`;
                                effectiveOffset = start;
                                hasMore = start > 0 || end < fullText.length;
                            }
                        }

                        if (!focused) {
                            if (effectiveOffset >= fullText.length && fullText.length > 0) {
                                throw new AppError({
                                    code: 'start_index_out_of_range',
                                    retryable: false,
                                    details: { legacyCode: 'ERR_START_INDEX_OUT_OF_RANGE', totalLength: fullText.length, startIndex: effectiveOffset },
                                    hint: `当前正文实际总长度为 totalLength=${fullText.length}，请将 startIndex 设为小于 ${fullText.length} 的偏移量（或重置为 0 从头读取）。`,
                                    message: `startIndex ${effectiveOffset} is beyond content length ${fullText.length}; reset to 0 to read from the beginning`
                                });
                            }
                            pageContent = fullText.slice(effectiveOffset, effectiveOffset + maxChars);
                            hasMore = fullText.length > effectiveOffset + maxChars;
                        }

                        const toc = hasMore ? generateMarkdownToc(fullText) : undefined;
                        return {
                            url,
                            finalUrl: url,
                            contentType: 'text/markdown',
                            title: articleTitle,
                            siteName: defaultSiteName,
                            retrievalMethod: 'request' as const,
                            truncated: hasMore,
                            content: pageContent,
                            totalLength: fullText.length,
                            startIndex: effectiveOffset,
                            hasMore,
                            nextStartIndex: hasMore ? effectiveOffset + maxChars : undefined,
                            ...(toc && toc.length > 0 ? { toc } : {}),
                            ...(focused ? { focused: true } : {})
                        };
                    };

                    const forwardToArticle = async (articleFetcher: ArticleFetcher, defaultSiteName: string) => {
                        const article = await articleFetcher(url, { format });
                        return formatMarkdownResult(article.content, article.title || '', defaultSiteName);
                    };

                    if (options?.fetchCsdn && validateArticleUrl(url, 'csdn')) {
                        return await forwardToArticle(options.fetchCsdn, 'CSDN博客');
                    }

                    if (options?.fetchJuejin && validateArticleUrl(url, 'juejin')) {
                        return await forwardToArticle(options.fetchJuejin, '稀土掘金');
                    }

                    if (options?.fetchGithub && validateGithubRepositoryUrl(url)) {
                        const ghContent = await options.fetchGithub(url);
                        if (ghContent) {
                            const isGitee = parsed.hostname.includes('gitee.com');
                            const siteName = isGitee ? 'Gitee' : 'GitHub';
                            return formatMarkdownResult(ghContent, `${siteName} Content`, siteName);
                        }
                    }

                    if (isStackOverflowQuestionUrl(url)) {
                        const soFetcher = options?.fetchStackOverflow ?? fetchStackOverflowQuestion;
                        const soContent = await soFetcher(url);
                        if (soContent) {
                            return formatMarkdownResult(soContent.content, soContent.title, 'Stack Overflow');
                        }
                    }
                } catch (forwardError) {
                    if (
                        forwardError instanceof AppError &&
                        (forwardError.code === 'not_found' ||
                            forwardError.code === 'start_index_out_of_range' ||
                            forwardError.code === 'bot_challenge')
                    ) {
                        throw forwardError;
                    }
                    // 若专有抓取器异常，平滑回退到通用 fetcher
                }
            }

            return fetcher(url, maxChars, { readability, includeLinks, raw, startIndex, format, focus, signal });
        }
    };
}
