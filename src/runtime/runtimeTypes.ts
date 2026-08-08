import { AppConfig } from '../config.js';
import { SearchExecutionInput, SearchExecutionResult } from '../core/search/searchService.js';
import { FetchWebContentResult } from '../engines/web/fetchWebContent.js';
import { Context7DocsResult, Context7Library } from '../engines/context7/context7.js';

export type SearchService = {
    execute(input: SearchExecutionInput): Promise<SearchExecutionResult>;
};

export type FetchArticleService = {
    execute(input: { url: string }): Promise<{ content: string }>;
};

export type GithubReadmeService = {
    execute(input: { url: string }): Promise<string | null>;
};

export type FetchWebService = {
    execute(input: {
        url: string;
        maxChars: number;
        readability?: boolean;
        includeLinks?: boolean;
        raw?: boolean;
        startIndex?: number;
    }): Promise<FetchWebContentResult>;
};

export type Context7LibrariesService = {
    execute(input: { libraryName: string; query: string; limit?: number }): Promise<{
        query: string;
        libraryName: string;
        results: Context7Library[];
    }>;
};

export type Context7DocsService = {
    execute(input: { libraryId: string; query: string; limit?: number }): Promise<Context7DocsResult>;
};

export type OpenWebSearchRuntimeServices = {
    search: SearchService;
    fetchCsdnArticle: FetchArticleService;
    fetchJuejinArticle: FetchArticleService;
    fetchGithubReadme: GithubReadmeService;
    fetchWeb: FetchWebService;
    context7Libraries: Context7LibrariesService;
    context7Docs: Context7DocsService;
};

export type OpenWebSearchRuntime = {
    config: AppConfig;
    services: OpenWebSearchRuntimeServices;
};
