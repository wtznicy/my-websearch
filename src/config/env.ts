/**
 * 统一环境变量访问层（P1-7）。
 *
 * 目标：默认值、类型转换、空值/非法值语义全部收敛在这里，业务代码不再直接读
 * `process.env`。所有函数都接受可选的 `env` 参数，便于测试注入。
 */
export type EnvLike = Record<string, string | undefined>;

const DEFAULT_ENV: EnvLike = process.env;

/** 原始 process.env 引用（供 configLoader、WeakMap 键或必须传递对象引用的场景使用） */
export function getProcessEnv(): NodeJS.ProcessEnv {
    return process.env;
}

/** 设置环境变量（集中收敛写操作） */
export function setEnv(name: string, value: string, env: EnvLike = DEFAULT_ENV): void {
    env[name] = value;
}

/** 删除/清除环境变量 */
export function unsetEnv(name: string, env: EnvLike = DEFAULT_ENV): void {
    delete env[name];
}

/** 原始值（不 trim、不做空值归一） */
export function getEnv(name: string, env: EnvLike = DEFAULT_ENV): string | undefined {
    return env[name];
}

/** 字符串：未设置或空白时返回 fallback */
export function getString(name: string, fallback: string, env: EnvLike = DEFAULT_ENV): string {
    const raw = env[name];
    if (raw === undefined) {
        return fallback;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : fallback;
}

/** 可选字符串：未设置或空白时返回 undefined（用于「未配置」语义） */
export function getOptionalString(name: string, env: EnvLike = DEFAULT_ENV): string | undefined {
    const raw = env[name];
    if (raw === undefined) {
        return undefined;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/** 数值：非法值回退 fallback，并可按 min/max 夹取 */
export function getNumber(
    name: string,
    fallback: number,
    options: { min?: number; max?: number; integer?: boolean } = {},
    env: EnvLike = DEFAULT_ENV
): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    let value = options.integer ? Math.trunc(parsed) : parsed;
    if (options.min !== undefined) {
        value = Math.max(options.min, value);
    }
    if (options.max !== undefined) {
        value = Math.min(options.max, value);
    }
    return value;
}

/** 布尔：1/true/yes/on 为真，0/false/no/off 为假，其它回退 fallback */
export function getBoolean(name: string, fallback: boolean, env: EnvLike = DEFAULT_ENV): boolean {
    const raw = env[name];
    if (raw === undefined) {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return fallback;
}

/** 逗号分隔列表：空值回退 fallback */
export function getList(name: string, fallback: string[], env: EnvLike = DEFAULT_ENV): string[] {
    const raw = env[name];
    if (raw === undefined) {
        return fallback;
    }
    const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : fallback;
}
