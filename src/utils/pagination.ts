/**
 * 通用分页收集工具：把"抓一页"的 fetchPage 包装成"抓够 limit 条"的循环。
 * 覆盖了多个搜索引擎重复的 while + concat + 空页 break + slice 模式。
 * 循环自带 maxPages 安全阀，避免引擎持续返回但去重后无进展时死循环。
 */
export type PaginateSearchOptions<T> = {
    /** 目标结果数 */
    limit: number;
    /** 抓取一页；pageIndex 从 initialPage 开始、按 pageStep 递增，由调用方自行映射为具体分页参数 */
    fetchPage: (pageIndex: number) => Promise<T[]>;
    initialPage?: number;
    pageStep?: number;
    /** 最大抓取页数（默认 10），防止异常时无限循环 */
    maxPages?: number;
    /** 每页之间的随机延迟范围 [min, max] ms；不设则无延迟 */
    pageDelayMs?: [number, number];
};

export async function paginateSearch<T>(options: PaginateSearchOptions<T>): Promise<T[]> {
    const {
        limit,
        fetchPage,
        initialPage = 0,
        pageStep = 1,
        maxPages = 10,
        pageDelayMs
    } = options;

    const allResults: T[] = [];
    let page = initialPage;

    for (let pageIndex = 0; pageIndex < maxPages && allResults.length < limit; pageIndex += 1) {
        if (pageDelayMs && pageIndex > 0) {
            const [min, max] = pageDelayMs;
            const delay = min + Math.random() * (max - min);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const results = await fetchPage(page);
        allResults.push(...results);
        if (results.length === 0) {
            break;
        }
        page += pageStep;
    }

    return allResults.slice(0, limit);
}
