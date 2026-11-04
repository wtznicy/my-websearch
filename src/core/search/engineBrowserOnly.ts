/**
 * 引擎「浏览器优先窗口」状态。
 *
 * 与 `engineCircuitBreaker` 的区别：
 * - 熔断 = 引擎**不可用**，路由/级联会把它剔除或换引擎；
 * - 浏览器优先 = 引擎**仍可用，但只能走浏览器兜底**（例如 Brave 无 key 路径吃了 429）。
 *
 * Brave 的用法：curl 429 → 开一个 180s 窗口，窗口内直接走伪装无头浏览器，
 * 不再用 curl 白撞（curl 只会继续吃 429 并延长服务端窗口）。窗口内兜底也失败时，
 * 调用方应升级为硬熔断（tripEngineCircuit），由路由/级联换引擎。
 */
const browserOnlyUntil = new Map<string, number>();

/** 打开（或延长）某引擎的浏览器优先窗口 */
export function setEngineBrowserOnly(engine: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return;
    }
    browserOnlyUntil.set(engine, Date.now() + durationMs);
}

/** 当前是否处于浏览器优先窗口（过期自动清除） */
export function isEngineBrowserOnly(engine: string): boolean {
    return getEngineBrowserOnlyRemainingMs(engine) > 0;
}

/** 窗口剩余毫秒数；0 表示不在窗口内 */
export function getEngineBrowserOnlyRemainingMs(engine: string): number {
    const until = browserOnlyUntil.get(engine);
    if (until === undefined) {
        return 0;
    }
    const remaining = until - Date.now();
    if (remaining <= 0) {
        browserOnlyUntil.delete(engine);
        return 0;
    }
    return remaining;
}

/** 清除窗口（测试与手动恢复用） */
export function clearEngineBrowserOnly(engine: string): void {
    browserOnlyUntil.delete(engine);
}

export function resetEngineBrowserOnly(): void {
    browserOnlyUntil.clear();
}
