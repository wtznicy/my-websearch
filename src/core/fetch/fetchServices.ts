import { FetchWebContentOptions, FetchWebContentResult, generateMarkdownToc } from '../../engines/web/fetchWebContent.js';
import type { ExtractSchema } from '../../engines/web/extract.js';
import type { FocusMode } from '../../engines/web/types.js';
import type { LinkRetentionMode } from '../../utils/linkRetention.js';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../validation/targetValidation.js';
import { AppError } from '../errors.js';
import { isStackOverflowQuestionUrl, fetchStackOverflowQuestion } from '../../engines/stackoverflow/fetchStackOverflow.js';
import { parseLineRangeInput, type LineRange } from '../../engines/github/lineRange.js';

export type ArticleFetchOptions = { format?: 'text' | 'markdown' };
export type ArticleFetcher = (url: string, options?: ArticleFetchOptions) => Promise<{ content: string; title?: string }>;
export type GithubReadmeFetcher = (url: string, lineRange?: LineRange, releaseLimit?: number) => Promise<string | null>;
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
        async execute({ url, lines, releaseLimit }: { url: string; lines?: string; releaseLimit?: number }): Promise<string | null> {
            if (!validateGithubRepositoryUrl(url)) {
                throw new AppError({
                    code: 'invalid_arguments',
                    retryable: false,
                    engine: 'github',
                    message: 'Invalid GitHub repository URL'
                });
            }

            return fetcher(url, parseLineRangeInput(lines), releaseLimit);
        }
    };
}

import { executeFetchPipeline } from './fetchPage.js';

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
        async execute(params: {
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
            citations?: boolean;
            retainLinks?: LinkRetentionMode;
            selector?: string;
            extract?: ExtractSchema;
            signal?: AbortSignal;
        }): Promise<FetchWebContentResult> {
            return executeFetchPipeline(
                {
                    ...params,
                    cache: params.cache ?? 'default'
                },
                {
                    fetchCsdn: options?.fetchCsdn,
                    fetchJuejin: options?.fetchJuejin,
                    fetchGithub: options?.fetchGithub,
                    fetchStackOverflow: options?.fetchStackOverflow,
                    genericFetcher: fetcher
                }
            );
        }
    };
}
