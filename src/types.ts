export interface SearchResult {
    title: string;
    url: string;
    description: string;
    /** 来源站点或作者昵称（社区类引擎如 CSDN/掘金返回作者名，通用引擎返回站点名或主域名） */
    source: string;
    engine: string;
    /** 跨引擎融合后该结果被几个引擎命中（仅多引擎搜索时出现，帮助 LLM 判断可信度） */
    engineHits?: number;
    /** 内部排序权重（如精确仓库命中）；返回给调用方前会被剥离，不进入公共 JSON */
    rankBoost?: number;
    /** RRF（Reciprocal Rank Fusion）融合分；内部字段，出口剥离 */
    rrfScore?: number;
    /** 发布/更新日期（如 "2025-11-20"、"2026-02" 等） */
    date?: string;
    /** 归一化 ISO 发布时间（YYYY-MM-DD） */
    publishedAt?: string;
    /** 抓取的正文内容（fetchTop 时注入） */
    fullContent?: string;
    /** 代码搜索（grep.app / code 引擎）相关字段 */
    repo?: string;
    path?: string;
    line?: number;
}

/**
 * 引擎单次搜索的返回：结果数组（可能带 directAnswer 数组属性）。
 * directAnswer 是 SERP 首位的直接答案卡片文本（百度汇率/百科卡等），
 * 让 LLM 无需抓详情页即可获取确切事实；由 searchService 聚合后冒泡到响应顶层。
 */
export type EngineSearchResponse = SearchResult[] & { directAnswer?: string };
