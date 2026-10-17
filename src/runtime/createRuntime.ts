import { config, AppConfig } from '../config.js';
import { ENGINE_REGISTRY, SearchEngineExecutorMap } from '../engines/registry.js';
import { fetchCsdnArticle } from '../engines/csdn/fetchCsdnArticle.js';
import { fetchJuejinArticle } from '../engines/juejin/fetchJuejinArticle.js';
import { fetchGithubReadme } from '../engines/github/index.js';
import { fetchStackOverflowQuestion } from '../engines/stackoverflow/fetchStackOverflow.js';
import { fetchWebContent } from '../engines/web/index.js';
import { createContext7Services } from '../core/context7/context7Service.js';
import { createSearchService, configureGlobalConcurrencyLimit } from '../core/search/searchService.js';
import {
    createArticleFetchService,
    createGithubReadmeService,
    createWebFetchService,
    ArticleFetcher,
    GithubReadmeFetcher,
    StackOverflowQuestionFetcher,
    WebFetcher
} from '../core/fetch/fetchServices.js';
import { MyWebSearchRuntime } from './runtimeTypes.js';

export type RuntimeDependencies = {
    searchExecutors?: SearchEngineExecutorMap;
    fetchCsdnArticle?: ArticleFetcher;
    fetchJuejinArticle?: ArticleFetcher;
    fetchGithubReadme?: GithubReadmeFetcher;
    fetchStackOverflow?: StackOverflowQuestionFetcher;
    fetchWebContent?: WebFetcher;
};

export type CreateMyWebSearchRuntimeOptions = {
    config?: AppConfig;
    dependencies?: RuntimeDependencies;
};

function createDefaultSearchExecutors(runtimeConfig?: AppConfig): SearchEngineExecutorMap {
    const all: SearchEngineExecutorMap = Object.fromEntries(
        ENGINE_REGISTRY.map((e) => [e.name, e.execute])
    );
    if (runtimeConfig?.allowedSearchEngines && runtimeConfig.allowedSearchEngines.length > 0) {
        const allowed = new Set(runtimeConfig.allowedSearchEngines);
        const filtered: SearchEngineExecutorMap = {};
        for (const [engine, fn] of Object.entries(all)) {
            if (allowed.has(engine)) {
                filtered[engine] = fn;
            }
        }
        return filtered;
    }
    return all;
}

export function createMyWebSearchRuntime(options: CreateMyWebSearchRuntimeOptions = {}): MyWebSearchRuntime {
    const runtimeConfig = options.config ?? config;
    const dependencies = options.dependencies ?? {};
    const searchExecutors = dependencies.searchExecutors ?? createDefaultSearchExecutors(runtimeConfig);
    // 只实例化一次 context7 服务，libraries/docs 共享同一份缓存
    const context7 = createContext7Services();

    // 初始化全局并发限制
    configureGlobalConcurrencyLimit(runtimeConfig.maxConcurrentSearches);

    return {
        config: runtimeConfig,
        services: {
            search: createSearchService(searchExecutors, undefined, runtimeConfig),
            fetchCsdnArticle: createArticleFetchService('csdn', dependencies.fetchCsdnArticle ?? fetchCsdnArticle),
            fetchJuejinArticle: createArticleFetchService('juejin', dependencies.fetchJuejinArticle ?? fetchJuejinArticle),
            fetchGithubReadme: createGithubReadmeService(dependencies.fetchGithubReadme ?? fetchGithubReadme),
            fetchWeb: createWebFetchService(dependencies.fetchWebContent ?? fetchWebContent, {
                fetchCsdn: dependencies.fetchCsdnArticle ?? fetchCsdnArticle,
                fetchJuejin: dependencies.fetchJuejinArticle ?? fetchJuejinArticle,
                fetchGithub: dependencies.fetchGithubReadme ?? fetchGithubReadme,
                fetchStackOverflow: dependencies.fetchStackOverflow ?? fetchStackOverflowQuestion
            }),
            context7Libraries: context7.libraries,
            context7Docs: context7.docs
        }
    };
}
