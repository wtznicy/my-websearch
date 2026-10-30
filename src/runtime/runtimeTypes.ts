import { AppConfig } from '../config.js';
import { SearchExecutionInput, SearchExecutionResult } from '../core/search/searchService.js';
import { FetchWebContentResult } from '../engines/web/fetchWebContent.js';
import type { FocusMode } from '../engines/web/types.js';
import type { LinkRetentionMode } from '../utils/linkRetention.js';
import type { ExtractSchema } from '../engines/web/extract.js';
import { Context7DocsResult, Context7Library } from '../engines/context7/context7.js';

export type SearchService = {
    execute(input: SearchExecutionInput): Promise<SearchExecutionResult>;
    /** 清空搜索 TTL 缓存 */
    clearCache(): void;
    /** 当前缓存条目数 */
    readonly cacheSize: number;
};

export type ArticleFormat = 'text' | 'markdown';

export type FetchArticleService = {
    /** format 目前由掘金实现（markdown 保留代码围栏与表格）；CSDN 忽略该参数 */
    execute(input: { url: string; format?: ArticleFormat }): Promise<{ content: string }>;
};

export type GithubReadmeService = {
    execute(input: { url: string; lines?: string; releaseLimit?: number }): Promise<string | null>;
};

export type FetchWebService = {
    execute(input: {
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
    }): Promise<FetchWebContentResult>;
};

export type Context7LibrariesService = {
    execute(input: { libraryName: string; query?: string; limit?: number }): Promise<{
        query: string;
        libraryName: string;
        results: Context7Library[];
    }>;
};

export type Context7DocsService = {
    execute(input: {
        library?: string;
        libraryId?: string;
        libraryName?: string;
        version?: string;
        query?: string;
        limit?: number;
        strict?: boolean;
        signal?: AbortSignal;
    }): Promise<Context7DocsResult>;
};

export type MyWebSearchRuntimeServices = {
    search: SearchService;
    fetchCsdnArticle: FetchArticleService;
    fetchJuejinArticle: FetchArticleService;
    fetchGithubReadme: GithubReadmeService;
    fetchWeb: FetchWebService;
    context7Libraries: Context7LibrariesService;
    context7Docs: Context7DocsService;
};

export type MyWebSearchRuntime = {
    config: AppConfig;
    services: MyWebSearchRuntimeServices;
};
