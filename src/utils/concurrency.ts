/**
 * 带总时间预算的并发映射。
 *
 * 场景：结果的中转链接解析是 N+1 网络请求（百度每条结果一次 HEAD、搜狗每条一次
 * 跳转跟随）。链接多时并发 4 的解析会累积数秒，把引擎整体耗时推过单引擎超时上限
 * （实测 baidu 14.6s / sogou 8.4s）。这里给解析阶段设总预算：预算耗尽后剩余条目
 * 直接使用 fallback 值（如保留原中转链接，仍可用），不再阻塞引擎返回。
 */
export async function mapWithConcurrencyBudget<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
    budgetMs: number,
    fallback: (item: T) => R
): Promise<R[]> {
    const results = items.map(fallback);
    if (items.length === 0) {
        return results;
    }

    const deadline = Date.now() + budgetMs;
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            if (Date.now() >= deadline) {
                return;
            }
            const index = next;
            next += 1;
            const item = items[index];
            if (item !== undefined) {
                try {
                    results[index] = await fn(item);
                } catch {
                    // 单条失败保留 fallback 值
                }
            }
        }
    });

    await Promise.all(workers);
    return results;
}
