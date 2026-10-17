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
    /** 可选去重键提取函数（如 (res) => res.url），跨页自动过滤重复项 */
    dedupKey?: (item: T) => string;
    /** 可选取消信号：触发时立即停止后续分页请求 */
    signal?: AbortSignal;
};

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }
    if (signal?.aborted) {
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Pagination aborted'));
    }
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason instanceof Error ? signal.reason : new Error('Pagination aborted'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export async function paginateSearch<T>(options: PaginateSearchOptions<T>): Promise<T[]> {
    const {
        limit,
        fetchPage,
        initialPage = 0,
        pageStep = 1,
        maxPages = 10,
        pageDelayMs,
        dedupKey,
        signal
    } = options;

    const allResults: T[] = [];
    const seenKeys = new Set<string>();
    // 直接答案卡片（百度汇率/百科卡等）：fetchPage 返回值上的数组属性，
    // concat/slice 会丢失——在循环里捕获，最终挂回返回数组供上层聚合
    let directAnswer: string | undefined;
    let page = initialPage;

    for (let pageIndex = 0; pageIndex < maxPages && allResults.length < limit; pageIndex += 1) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('Pagination aborted');
        }
        if (pageDelayMs && pageIndex > 0) {
            const [min, max] = pageDelayMs;
            const delay = min + Math.random() * (max - min);
            await delayWithSignal(delay, signal);
        }

        let results: T[];
        try {
            results = await fetchPage(page);
        } catch (pageError) {
            // 如果首页已成功收集到部分结果，后续分页偶发失败时不应抹杀已有结果
            if (pageIndex > 0 && allResults.length > 0) {
                console.warn(`Pagination fetchPage failed on page ${page}, gracefully returning ${allResults.length} collected results:`, pageError instanceof Error ? pageError.message : String(pageError));
                break;
            }
            throw pageError;
        }
        const pageAnswer = (results as { directAnswer?: unknown })?.directAnswer;
        if (!directAnswer && typeof pageAnswer === 'string' && pageAnswer) {
            directAnswer = pageAnswer;
        }

        if (results.length === 0) {
            break;
        }

        let addedThisPage = 0;
        for (const item of results) {
            if (dedupKey) {
                const key = dedupKey(item);
                if (seenKeys.has(key)) {
                    continue;
                }
                seenKeys.add(key);
            }
            allResults.push(item);
            addedThisPage += 1;
            if (allResults.length >= limit) {
                break;
            }
        }

        // 若配置了去重键且整页无任何新增结果（如全部重复），提前结束避免空转
        if (dedupKey && addedThisPage === 0) {
            break;
        }

        page += pageStep;
    }

    const finalResults = allResults.slice(0, limit);
    if (directAnswer) {
        (finalResults as { directAnswer?: string }).directAnswer = directAnswer;
    }
    return finalResults;
}
