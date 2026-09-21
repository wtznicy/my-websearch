import { SearchResult } from '../../types.js';

/**
 * 多查询扇出结果的公平合并。
 *
 * 背景：此前的"顺序拼接 + 按 limit 截断"会让返回最多的 query（通常是首个）
 * 赢者通吃——实测 2 query（英文+中文）时，bing 的两个英文 query 贡献整列、
 * limit 6 里占 5 条，唯一有效的中文结果被挤到最后一位，limit 再小就直接消失。
 *
 * 策略（两轮）：
 * 1. 每个 query 保底配额 perQueryQuota = max(2, ceil(limit / queryCount))，
 *    按序取各自前 N 条（去重）；
 * 2. 若保底轮未填满 limit，按 round-robin 从各 query 剩余结果里补足。
 *
 * URL 去重贯穿全程（保留首次出现）。各 query 内部结果已在 searchService 完成
 * rerank，这里只保证"多意图"的配额公平，不再重排。
 */

/** 报告/统计用的聚合指标形状（与 SearchExecutionResult.engineMetrics 一致） */
export type EngineMetric = { engine: string; ms: number; count: number; error?: string; timedOut?: boolean };

/** URL 归一化：去 hash 与常见跟踪参数（与 searchService 的归一化保持一致的简化版） */
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
    const queryCount = perQueryResults.length;
    const totalBeforeDedupe = perQueryResults.reduce((sum, list) => sum + list.length, 0);

    if (queryCount === 0 || limit <= 0) {
        return { results: [], totalBeforeDedupe };
    }

    const seen = new Set<string>();
    const picked: SearchResult[] = [];

    const tryTake = (result: SearchResult): boolean => {
        const key = normalizeForDedupe(result.url);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        picked.push(result);
        return true;
    };

    // 单查询：退化为去重 + 截断
    if (queryCount === 1) {
        for (const result of perQueryResults[0]) {
            if (picked.length >= limit) {
                break;
            }
            tryTake(result);
        }
        return { results: picked, totalBeforeDedupe };
    }

    // 第一轮：每个 query 保底配额（保证多意图都有代表）
    const perQueryQuota = Math.max(2, Math.ceil(limit / queryCount));
    const cursors = perQueryResults.map((list) => {
        let taken = 0;
        let index = 0;
        while (index < list.length && taken < perQueryQuota && picked.length < limit) {
            if (tryTake(list[index])) {
                taken += 1;
            }
            index += 1;
        }
        return index;
    });

    // 第二轮：round-robin 补足剩余名额（保底轮之后仍有空间时）
    let progress = true;
    while (picked.length < limit && progress) {
        progress = false;
        for (let i = 0; i < queryCount && picked.length < limit; i += 1) {
            const list = perQueryResults[i];
            while (cursors[i] < list.length) {
                const result = list[cursors[i]];
                cursors[i] += 1;
                if (tryTake(result)) {
                    progress = true;
                    break;
                }
            }
        }
    }

    return { results: picked.slice(0, limit), totalBeforeDedupe };
}

/** 多查询的 engineMetrics 合并：按引擎聚合（ms/count 求和，error 取首个非空） */
export function mergeEngineMetricsAcrossQueries(
    metricLists: Array<EngineMetric[] | undefined>
): EngineMetric[] {
    const byEngine = new Map<string, EngineMetric>();
    for (const list of metricLists) {
        for (const metric of list ?? []) {
            const existing = byEngine.get(metric.engine);
            if (!existing) {
                byEngine.set(metric.engine, { ...metric });
                continue;
            }
            existing.ms += metric.ms;
            existing.count += metric.count;
            if (!existing.error && metric.error) {
                existing.error = metric.error;
            }
            if (metric.timedOut) {
                existing.timedOut = true;
            }
        }
    }
    return [...byEngine.values()];
}
