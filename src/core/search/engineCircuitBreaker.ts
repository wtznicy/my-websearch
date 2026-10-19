/**
 * 引擎级熔断器（内存状态机，进程内共享）。
 *
 * 背景：部分引擎的失败是 **IP 级/短窗口** 的，而不是单次请求偶发：
 * - Brave 429：AWS CloudFront + WAF 的 IP Rate-based Rule，分钟级窗口内持续 429；
 * - DuckDuckGo 202：出口 IP 的短窗口配额（实测约 30s 恢复，连续 3~4 次后触发）；
 * - Bing/其它 bot_challenge：可能持续数分钟。
 *
 * 固定 5 分钟会把一次瞬时 202 放大成整段会话不可用，因此改用自适应冷却：
 * - 首次熔断 30s；
 * - 同一引擎连续触发时指数退避（60s → 120s → 240s → 300s 上限）；
 * - 任意一次成功调用立即清零；
 * - 期间 searchService 跳过该引擎并把配额平移给其他引擎，级联候选同样排除。
 */

const DEFAULT_BASE_COOLDOWN_MS = 30 * 1000;
const DEFAULT_MAX_COOLDOWN_MS = 5 * 60 * 1000;

const blockedUntil = new Map<string, number>();
const consecutiveTrips = new Map<string, number>();

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : fallback;
}

/** 首次熔断的基础冷却时间（毫秒） */
export function getEngineCircuitBaseCooldownMs(): number {
    return readPositiveIntEnv('ENGINE_CIRCUIT_BASE_COOLDOWN_MS', DEFAULT_BASE_COOLDOWN_MS);
}

/** 指数退避后的最大冷却时间（毫秒），不会小于基础值 */
export function getEngineCircuitMaxCooldownMs(): number {
    const base = getEngineCircuitBaseCooldownMs();
    return Math.max(base, readPositiveIntEnv('ENGINE_CIRCUIT_MAX_COOLDOWN_MS', DEFAULT_MAX_COOLDOWN_MS));
}

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

/**
 * 触发熔断，返回本次实际冷却时长（毫秒）。
 * - 不传 cooldownMs：按连续触发次数指数退避（60s → 120s → 240s → 300s 上限）；
 * - 传 cooldownMs：使用显式值（测试/特殊场景），不参与指数退避。
 */
export function tripEngineCircuit(engine: string, cooldownMs?: number): number {
    const trips = (consecutiveTrips.get(engine) ?? 0) + 1;
    consecutiveTrips.set(engine, trips);

    const base = cooldownMs ?? getEngineCircuitBaseCooldownMs();
    const effective = cooldownMs !== undefined
        ? Math.max(1000, Math.floor(cooldownMs))
        : Math.min(base * (2 ** (trips - 1)), getEngineCircuitMaxCooldownMs());

    blockedUntil.set(engine, Date.now() + effective);
    return effective;
}

/** 成功调用后清零该引擎的连续失败计数与熔断状态 */
export function recordEngineSuccess(engine: string): void {
    consecutiveTrips.delete(engine);
    blockedUntil.delete(engine);
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

/** 当前连续触发次数（测试/诊断用） */
export function getEngineCircuitTripCount(engine: string): number {
    return consecutiveTrips.get(engine) ?? 0;
}

/** 清空全部熔断状态（测试/手动恢复用） */
export function resetEngineCircuits(): void {
    blockedUntil.clear();
    consecutiveTrips.clear();
}
