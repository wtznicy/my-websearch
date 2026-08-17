export interface SearchResult {
    title: string;
    url: string;
    description: string;
    source: string;
    engine: string;
    /** 跨引擎融合后该结果被几个引擎命中（仅多引擎搜索时出现，帮助 LLM 判断可信度） */
    engineHits?: number;
}
