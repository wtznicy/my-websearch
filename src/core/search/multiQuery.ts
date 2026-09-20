import { SearchResult } from '../../types.js';

/**
 * 多查询扇出结果的合并：按规范化 URL 去重（保留首次出现），
 * 用于 search 工具一次接收 1-4 个 query（覆盖不同意图）时的结果融合。
 *
 * 注意与 mergeSearchResults 的区别：后者处理"同一查询的多个引擎结果"并
 * 计算 engineHits（跨引擎共识）；这里是"多个不同查询各自已融合的结果"，
 * 不重算 engineHits（各条保留自身查询内的共识值）。
 */

/** URL 归一化：去 hash、常见跟踪参数（与 searchService 的归一化保持一致的简化版） */
function normalizeForDedupe(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
            if (/^(utm_|spm|from|src|ref|ops_request_misc|spm_id_from)/i.test(key)) {
                url.searchParams.delete(key);
            }
        }
        return url.toString();
    } catch {
        return rawUrl;
    }
}

export function mergeMultiQueryResults(
    perQueryResults: SearchResult[][],
    limit: number
): { results: SearchResult[]; totalBeforeDedupe: number } {
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    let totalBeforeDedupe = 0;

    for (const queryResults of perQueryResults) {
        for (const result of queryResults) {
            totalBeforeDedupe += 1;
            const key = normalizeForDedupe(result.url);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            results.push(result);
            if (results.length >= limit) {
                return { results, totalBeforeDedupe };
            }
        }
    }

    return { results, totalBeforeDedupe };
}
