/**
 * 引擎级熔断器（内存状态机，进程内共享）。
 *
 * 背景：Brave 的 429 并非后端限流，而是 AWS CloudFront + WAF 的 **IP 级 Rate-based Rule**
 * 在边缘直接拦截（实测响应带 `x-cache: Error from cloudfront`）——被标记的出口 IP
 * 在分钟级窗口内必然持续 429，秒级重试毫无意义，只会浪费 5~8 秒。
 *
 * 因此：引擎遭遇 429 后熔断一段时间（默认 5 分钟），期间：
 * - searchService 跳过该引擎的调用，并把配额平移给其他引擎（0ms 无感避障，不等报错再级联）
 * - 级联候选同样排除熔断引擎（避免换个阶段继续撞限流）
 */

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

const blockedUntil = new Map<string, number>();

/** 熔断是否生效（到期自动清除） */
export function isEngineCircuitOpen(engine: string): boolean {
    const until = blockedUntil.get(engine);
    if (until === undefined) {
        return false;
    }
    if (Date.now() >= until) {
        blockedUntil.delete(engine);
        return false;
    }
    return true;
}

/** 触发熔断（默认 5 分钟；重复触发会延长至最新时间点） */
export function tripEngineCircuit(engine: string, cooldownMs: number = DEFAULT_COOLDOWN_MS): void {
    blockedUntil.set(engine, Date.now() + cooldownMs);
}

/** 剩余冷却时间（毫秒；未熔断为 0） */
export function getEngineCircuitRemainingMs(engine: string): number {
    const until = blockedUntil.get(engine);
    if (until === undefined) {
        return 0;
    }
    const remaining = until - Date.now();
    if (remaining <= 0) {
        blockedUntil.delete(engine);
        return 0;
    }
    return remaining;
}

/** 清空全部熔断状态（测试/手动恢复用） */
export function resetEngineCircuits(): void {
    blockedUntil.clear();
}
