export interface SearchResult {
    title: string;
    url: string;
    description: string;
    source: string;
    engine: string;
    /** 跨引擎融合后该结果被几个引擎命中（仅多引擎搜索时出现，帮助 LLM 判断可信度） */
    engineHits?: number;
}

/**
 * 引擎单次搜索的返回：结果数组（可能带 directAnswer 数组属性）。
 * directAnswer 是 SERP 首位的直接答案卡片文本（百度汇率/百科卡等），
 * 让 LLM 无需抓详情页即可获取确切事实；由 searchService 聚合后冒泡到响应顶层。
 */
export type EngineSearchResponse = SearchResult[] & { directAnswer?: string };
