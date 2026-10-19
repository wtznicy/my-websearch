import { AppError } from '../core/errors.js';

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

// ---------------------------------------------------------------------------
// 简单信号量：限制并发搜索数（支持队列上限、排队超时与 AbortSignal 取消）
// 从 searchService 抽出，避免核心三模块（searchService/engineExecutor/cascadeExecutor）环形依赖。
// ---------------------------------------------------------------------------

type SemaphoreWaiter = {
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
    cleanupAbort?: () => void;
};

export class Semaphore {
    private permits: number;
    private readonly maxQueueSize: number;
    private waitQueue: SemaphoreWaiter[] = [];

    constructor(permits: number, maxQueueSize = Math.max(16, permits * 4)) {
        this.permits = permits;
        this.maxQueueSize = maxQueueSize;
    }

    async acquire(deadlineAt?: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new AppError({ code: 'aborted', retryable: false, message: 'Aborted while acquiring concurrency slot' });
        }
        if (this.permits > 0) {
            this.permits -= 1;
            return;
        }
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
            throw new AppError({
                code: 'network_timeout',
                retryable: true,
                message: 'Search deadline exhausted before acquiring concurrency slot'
            });
        }
        if (this.waitQueue.length >= this.maxQueueSize) {
            throw new AppError({
                code: 'queue_full',
                retryable: true,
                message: `Search concurrency queue is full (max ${this.maxQueueSize} waiting requests)`
            });
        }

        return new Promise<void>((resolve, reject) => {
            const waiter: SemaphoreWaiter = {
                resolve: () => {
                    if (waiter.timer) {
                        clearTimeout(waiter.timer);
                    }
                    waiter.cleanupAbort?.();
                    resolve();
                },
                reject: (err: Error) => {
                    if (waiter.timer) {
                        clearTimeout(waiter.timer);
                    }
                    waiter.cleanupAbort?.();
                    reject(err);
                }
            };

            if (signal) {
                const onAbort = () => {
                    const idx = this.waitQueue.indexOf(waiter);
                    if (idx !== -1) {
                        this.waitQueue.splice(idx, 1);
                    }
                    waiter.reject(
                        signal.reason instanceof Error
                            ? signal.reason
                            : new AppError({ code: 'aborted', retryable: false, message: 'Aborted while waiting in concurrency queue' })
                    );
                };
                signal.addEventListener('abort', onAbort, { once: true });
                waiter.cleanupAbort = () => signal.removeEventListener('abort', onAbort);
            }

            if (deadlineAt !== undefined) {
                const remainingMs = Math.max(0, deadlineAt - Date.now());
                waiter.timer = setTimeout(() => {
                    const idx = this.waitQueue.indexOf(waiter);
                    if (idx !== -1) {
                        this.waitQueue.splice(idx, 1);
                    }
                    waiter.reject(new AppError({
                        code: 'network_timeout',
                        retryable: true,
                        message: `Search timed out after waiting ${remainingMs}ms in concurrency queue`
                    }));
                }, remainingMs);
            }

            this.waitQueue.push(waiter);
        });
    }

    release(): void {
        const next = this.waitQueue.shift();
        if (next) {
            next.resolve();
        } else {
            this.permits += 1;
        }
    }
}
