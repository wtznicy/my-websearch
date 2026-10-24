import type { AppConfig } from '../config.js';
import type { SearchResult } from '../types.js';

import { searchBaidu } from './baidu/baidu.js';
import { searchBing } from './bing/bing.js';
import { resetBingImpersonateStateForTests } from './bing/impersonate.js';
import { searchCsdn } from './csdn/csdn.js';
import { searchDuckDuckGo } from './duckduckgo/index.js';
import { searchExa } from './exa/index.js';
import { searchBrave, resetBraveOfficialApiCooldown } from './brave/index.js';
import { searchJuejin } from './juejin/index.js';
import { searchStartpage, resetStartpageCache } from './startpage/startpage.js';
import { searchYahoo } from './yahoo/yahoo.js';
import { searchSogou, resetSogouState } from './sogou/sogou.js';
import { searchGithub } from './github/searchGithub.js';
import { searchStackOverflow } from './stackoverflow/stackoverflow.js';
import { searchHackerNews } from './hackernews/hackernews.js';
import { searchArxiv } from './arxiv/arxiv.js';
import { searchGrepApp } from './code/grepApp.js';

import type {
    SearchExecutionContext,
    SearchEngineExecutor,
    SearchEngineExecutorMap
} from '../core/search/searchTypes.js';

export type { SearchExecutionContext, SearchEngineExecutor, SearchEngineExecutorMap };

export const SUPPORTED_SEARCH_ENGINES = [
    'baidu',
    'bing',
    'csdn',
    'duckduckgo',
    'exa',
    'brave',
    'juejin',
    'startpage',
    'yahoo',
    'sogou',
    'github',
    'stackoverflow',
    'hackernews',
    'arxiv',
    'code'
] as const;

export type SupportedSearchEngine = typeof SUPPORTED_SEARCH_ENGINES[number];

export interface EngineDescriptor {
    /** 标准引擎标识 */
    name: SupportedSearchEngine;
    /** 人类可读标签（用于 MCP 工具描述与展示） */
    label: string;
    /** 别名列表（用于 normalizeEngineName 归一化） */
    aliases?: readonly string[];
    /** 国内外网络分区（决定默认代理名单与海外可达性探测） */
    region: 'domestic' | 'overseas';
    /** 级联补位优先级配置（数值越小越优先，undefined 表示不参与该语种级联） */
    cascade: {
        zhPriority?: number;
        enPriority?: number;
    };
    /** 是否原生支持 site: 域名过滤语法 */
    supportsNativeSite: boolean;
    /** 是否支持 Playwright 浏览器渲染模式兜底 */
    supportsPlaywright: boolean;
    /** 单引擎默认超时预算（毫秒） */
    defaultTimeoutMs: number;
    /** Doctor 诊断探针 URL */
    probeUrl: string;
    /** 核心搜索执行函数 */
    execute: SearchEngineExecutor;
    /** Doctor --reset-health 状态清理钩子 */
    resetHealth?: () => void;
}

export const ENGINE_REGISTRY: readonly EngineDescriptor[] = [
    {
        name: 'baidu',
        label: 'Baidu(百度)',
        aliases: ['baidu'],
        region: 'domestic',
        cascade: { zhPriority: 10 },
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 8000,
        probeUrl: 'https://www.baidu.com/s?wd=mcp&rn=1',
        execute: searchBaidu
    },
    {
        name: 'bing',
        label: 'Bing',
        aliases: ['bing'],
        region: 'domestic',
        cascade: { zhPriority: 30, enPriority: 10 },
        supportsNativeSite: true,
        supportsPlaywright: true,
        defaultTimeoutMs: 10000,
        probeUrl: 'https://cn.bing.com/search?q=mcp&count=1',
        execute: searchBing,
        resetHealth: resetBingImpersonateStateForTests
    },
    {
        name: 'csdn',
        label: 'Csdn',
        aliases: ['csdn'],
        region: 'domestic',
        cascade: { zhPriority: 50 },
        supportsNativeSite: false,
        supportsPlaywright: false,
        defaultTimeoutMs: 8000,
        probeUrl: 'https://so.csdn.net/api/v3/search?q=mcp&t=all&p=1&s=0&tm=0&lv=-1&ft=0&l=&u=',
        execute: searchCsdn
    },
    {
        name: 'duckduckgo',
        label: 'DuckDuckGo',
        aliases: ['duckduckgo', 'ddg'],
        region: 'overseas',
        cascade: { zhPriority: 60, enPriority: 20 },
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 10000,
        probeUrl: 'https://html.duckduckgo.com/html/?q=mcp',
        execute: searchDuckDuckGo
    },
    {
        name: 'exa',
        label: 'Exa',
        aliases: ['exa'],
        region: 'overseas',
        cascade: { zhPriority: 80, enPriority: 40 },
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 10000,
        probeUrl: 'https://api.exa.ai',
        execute: searchExa
    },
    {
        name: 'brave',
        label: 'Brave',
        aliases: ['brave'],
        region: 'overseas',
        cascade: { zhPriority: 70, enPriority: 30 },
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 10000,
        probeUrl: 'https://search.brave.com/search?q=mcp',
        execute: searchBrave,
        resetHealth: resetBraveOfficialApiCooldown
    },
    {
        name: 'juejin',
        label: 'Juejin(掘金)',
        aliases: ['juejin'],
        region: 'domestic',
        cascade: { zhPriority: 40 },
        supportsNativeSite: false,
        supportsPlaywright: false,
        defaultTimeoutMs: 8000,
        probeUrl: 'https://api.juejin.cn',
        execute: searchJuejin
    },
    {
        name: 'startpage',
        label: 'Startpage',
        aliases: ['startpage'],
        region: 'overseas',
        cascade: { zhPriority: 90, enPriority: 50 },
        supportsNativeSite: true,
        supportsPlaywright: true,
        defaultTimeoutMs: 10000,
        probeUrl: 'https://www.startpage.com/sp/search?query=mcp',
        execute: searchStartpage,
        resetHealth: resetStartpageCache
    },
    {
        name: 'yahoo',
        label: 'Yahoo',
        aliases: ['yahoo'],
        region: 'overseas',
        // 不配置级联优先级：Yahoo 只作为英文主路由的健康替补（见 queryEngineRouting）与显式引擎，
        // 避免日常查询与 bing 重复消耗同一份 Bing 索引。
        cascade: {},
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 12000,
        probeUrl: 'https://search.yahoo.com/',
        execute: searchYahoo
    },
    {
        name: 'sogou',
        label: 'Sogou(搜狗)',
        aliases: ['sogou', 'sougou', '搜狗'],
        region: 'domestic',
        cascade: { zhPriority: 20 },
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 8000,
        probeUrl: 'https://m.sogou.com/web/searchList.jsp?keyword=mcp',
        execute: searchSogou,
        resetHealth: resetSogouState
    },
    {
        name: 'github',
        label: 'GitHub',
        aliases: ['github', 'gh'],
        region: 'overseas',
        cascade: { zhPriority: 75, enPriority: 35 },
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 10000,
        probeUrl: 'https://api.github.com',
        execute: searchGithub
    },
    {
        name: 'stackoverflow',
        label: 'StackOverflow',
        aliases: ['stackoverflow', 'so'],
        region: 'overseas',
        cascade: { zhPriority: 85, enPriority: 25 },
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 10000,
        probeUrl: 'https://api.stackexchange.com',
        execute: searchStackOverflow
    },
    {
        name: 'hackernews',
        label: 'HackerNews',
        aliases: ['hackernews', 'hn'],
        region: 'overseas',
        cascade: { enPriority: 45 },
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 8000,
        probeUrl: 'https://hn.algolia.com/api/v1/search?query=test',
        execute: searchHackerNews
    },
    {
        name: 'arxiv',
        label: 'arXiv',
        aliases: ['arxiv'],
        region: 'overseas',
        cascade: { zhPriority: 95, enPriority: 55 },
        supportsNativeSite: true,
        supportsPlaywright: false,
        defaultTimeoutMs: 10000,
        probeUrl: 'https://export.arxiv.org/api/query?search_query=all:electron&max_results=1',
        execute: searchArxiv
    },
    {
        name: 'code',
        label: 'GrepApp(Code)',
        aliases: ['code', 'grep', 'grepapp'],
        region: 'overseas',
        cascade: { enPriority: 60 },
        supportsNativeSite: false,
        supportsPlaywright: false,
        defaultTimeoutMs: 8000,
        probeUrl: 'https://grep.app',
        execute: searchGrepApp
    }
] as const;

/** 辅助查找单个引擎的描述符 */
export function getEngineDescriptor(name: string): EngineDescriptor | undefined {
    const normalized = name.trim().toLowerCase();
    return ENGINE_REGISTRY.find((e) => e.name === normalized);
}

/** 获取人类可读的引擎展示标签 */
export function getEngineLabel(name: string): string {
    const descriptor = getEngineDescriptor(name);
    return descriptor?.label ?? (name.charAt(0).toUpperCase() + name.slice(1));
}
