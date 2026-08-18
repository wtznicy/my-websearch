import { config, AppConfig } from '../config.js';
import { searchBaidu } from '../engines/baidu/baidu.js';
import { searchBing } from '../engines/bing/bing.js';
import { searchCsdn } from '../engines/csdn/csdn.js';
import { searchDuckDuckGo } from '../engines/duckduckgo/index.js';
import { searchExa } from '../engines/exa/index.js';
import { searchBrave } from '../engines/brave/index.js';
import { searchJuejin } from '../engines/juejin/index.js';
import { searchStartpage } from '../engines/startpage/index.js';
import { searchSogou } from '../engines/sogou/index.js';
import { fetchCsdnArticle } from '../engines/csdn/fetchCsdnArticle.js';
import { fetchJuejinArticle } from '../engines/juejin/fetchJuejinArticle.js';
import { fetchGithubReadme } from '../engines/github/index.js';
import { fetchWebContent } from '../engines/web/index.js';
import { createContext7Services } from '../core/context7/context7Service.js';
import { createSearchService, configureGlobalConcurrencyLimit, SearchEngineExecutorMap } from '../core/search/searchService.js';import {
    createArticleFetchService,
    createGithubReadmeService,
    createWebFetchService,
    ArticleFetcher,
    GithubReadmeFetcher,
    WebFetcher
} from '../core/fetch/fetchServices.js';
import { MyWebSearchRuntime } from './runtimeTypes.js';

export type RuntimeDependencies = {
    searchExecutors?: SearchEngineExecutorMap;
    fetchCsdnArticle?: ArticleFetcher;
    fetchJuejinArticle?: ArticleFetcher;
    fetchGithubReadme?: GithubReadmeFetcher;
    fetchWebContent?: WebFetcher;
};

export type CreateMyWebSearchRuntimeOptions = {
    config?: AppConfig;
    dependencies?: RuntimeDependencies;
};

function createDefaultSearchExecutors(): SearchEngineExecutorMap {
    return {
        baidu: searchBaidu,
        bing: searchBing,
        csdn: searchCsdn,
        duckduckgo: searchDuckDuckGo,
        exa: searchExa,
        brave: searchBrave,
        juejin: searchJuejin,
        startpage: searchStartpage,
        sogou: searchSogou
    };
}

export function createMyWebSearchRuntime(options: CreateMyWebSearchRuntimeOptions = {}): MyWebSearchRuntime {
    const runtimeConfig = options.config ?? config;
    const dependencies = options.dependencies ?? {};
    const searchExecutors = dependencies.searchExecutors ?? createDefaultSearchExecutors();
    // 只实例化一次 context7 服务，libraries/docs 共享同一份缓存
    const context7 = createContext7Services();

    // 初始化全局并发限制
    configureGlobalConcurrencyLimit(runtimeConfig.maxConcurrentSearches);

    return {
        config: runtimeConfig,
        services: {
            search: createSearchService(searchExecutors),
            fetchCsdnArticle: createArticleFetchService('csdn', dependencies.fetchCsdnArticle ?? fetchCsdnArticle),
            fetchJuejinArticle: createArticleFetchService('juejin', dependencies.fetchJuejinArticle ?? fetchJuejinArticle),
            fetchGithubReadme: createGithubReadmeService(dependencies.fetchGithubReadme ?? fetchGithubReadme),
            fetchWeb: createWebFetchService(dependencies.fetchWebContent ?? fetchWebContent),
            context7Libraries: context7.libraries,
            context7Docs: context7.docs
        }
    };
}
