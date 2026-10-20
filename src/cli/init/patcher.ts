import fs from 'node:fs';
import path from 'node:path';
import { CANONICAL_SERVER_KEY, SERVER_KEY_ALIASES, type ConfigShape } from './clientTargets.js';

/**
 * 客户端配置文件的「读 → 合并 → diff → 备份 → 写入」。
 *
 * 三条安全底线：
 * 1. 文件不是合法 JSON 时**拒绝修改**（报错退出，绝不覆盖）；
 * 2. 已有同名/别名条目且内容不同 → 默认跳过，必须 `--force` 才覆盖；
 * 3. 覆写前一定先留 `.bak.<时间戳>` 备份。
 */

export type PatchAction = 'create' | 'update' | 'unchanged' | 'conflict';

export type ConfigDocument = {
    /** 原始文本；文件不存在时为 null */
    raw: string | null;
    data: Record<string, unknown>;
};

export type PatchPlan = {
    configPath: string;
    shape: ConfigShape;
    action: PatchAction;
    /** 写入时使用的键名（update 会顺带把历史别名迁移到规范名） */
    serverKey: string;
    /** 命中的已有键名；没有则为 null */
    existingKey: string | null;
    previousEntry: unknown;
    nextEntry: Record<string, unknown>;
    previousRaw: string | null;
    /** 需要写入的内容；action 为 unchanged/conflict 时为 null */
    nextRaw: string | null;
    /** 该目标此前是否有可写目录 */
    directoryExists: boolean;
};

export type ApplyResult = {
    written: boolean;
    backupPath: string | null;
};

const isErrnoError = (error: unknown): error is NodeJS.ErrnoException => (
    typeof error === 'object' && error !== null && 'code' in error
);

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** 读取配置；文件缺失返回空文档，非法 JSON 抛出可读错误。 */
export function readConfigDocument(configPath: string): ConfigDocument {
    let raw: string | null;
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
        if (isErrnoError(error) && error.code === 'ENOENT') {
            return { raw: null, data: {} };
        }
        throw error;
    }

    const body = raw.replace(/^\uFEFF/, '').trim();
    if (!body) {
        return { raw, data: {} };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error(
            `Refusing to modify ${configPath}: the file is not valid JSON. Fix or move it, then re-run init.`
        );
    }

    if (!isPlainObject(parsed)) {
        throw new Error(
            `Refusing to modify ${configPath}: expected a JSON object at the top level.`
        );
    }

    return { raw, data: parsed };
}

/** 在容器对象里查找本服务器已存在的条目，返回命中的键名。 */
export function findExistingServerKey(data: Record<string, unknown>, shape: ConfigShape): string | null {
    const container = data[shape];
    if (!isPlainObject(container)) {
        return null;
    }
    for (const key of SERVER_KEY_ALIASES) {
        if (container[key] !== undefined) {
            return key;
        }
    }
    return null;
}

/** 递归排序键名后序列化，用于与条目做结构相等比较（忽略键顺序）。 */
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (isPlainObject(value)) {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = canonicalize(value[key]);
        }
        return sorted;
    }
    return value;
}

export function entriesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

export function serializeDocument(data: Record<string, unknown>): string {
    return `${JSON.stringify(data, null, 2)}\n`;
}

export type PatchOptions = {
    configPath: string;
    shape: ConfigShape;
    entry: Record<string, unknown>;
    force: boolean;
};

/**
 * 计算补丁方案，不产生任何副作用。
 * 调用方拿到 plan 后可以先展示 diff（--dry-run），再决定是否 applyPatch。
 */
export function planPatch(options: PatchOptions): PatchPlan {
    const { configPath, shape, entry, force } = options;
    const directoryExists = fs.existsSync(path.dirname(configPath));
    const document = readConfigDocument(configPath);
    const existingKey = findExistingServerKey(document.data, shape);

    const base = {
        configPath,
        shape,
        serverKey: CANONICAL_SERVER_KEY,
        existingKey,
        previousRaw: document.raw,
        nextEntry: entry,
        directoryExists
    };

    if (existingKey === null) {
        const existingContainer = document.data[shape];
        const container = isPlainObject(existingContainer) ? existingContainer : {};
        const nextData: Record<string, unknown> = {
            ...document.data,
            [shape]: { ...container, [CANONICAL_SERVER_KEY]: entry }
        };
        return {
            ...base,
            action: 'create',
            previousEntry: null,
            nextRaw: serializeDocument(nextData)
        };
    }

    const container = document.data[shape] as Record<string, unknown>;
    const previousEntry = container[existingKey];

    if (entriesEqual(previousEntry, entry) && existingKey === CANONICAL_SERVER_KEY) {
        return {
            ...base,
            action: 'unchanged',
            previousEntry,
            nextRaw: null
        };
    }

    if (!force) {
        return {
            ...base,
            action: 'conflict',
            previousEntry,
            nextRaw: null
        };
    }

    // force：用规范键名重写，并移除历史别名，避免同一客户端出现两份条目
    const nextContainer: Record<string, unknown> = { ...container };
    delete nextContainer[existingKey];
    nextContainer[CANONICAL_SERVER_KEY] = entry;
    const nextData: Record<string, unknown> = {
        ...document.data,
        [shape]: nextContainer
    };

    return {
        ...base,
        action: 'update',
        previousEntry,
        nextRaw: serializeDocument(nextData)
    };
}

const formatTimestamp = (date: Date): string => {
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
    ].join('') + '-' + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
        pad(date.getMilliseconds(), 3)
    ].join('');
};

function resolveBackupPath(configPath: string): string {
    const stamp = formatTimestamp(new Date());
    const base = `${configPath}.bak.${stamp}`;
    if (!fs.existsSync(base)) {
        return base;
    }
    for (let index = 1; index < 100; index += 1) {
        const candidate = `${base}-${index}`;
        if (!fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`Unable to allocate a backup filename next to ${configPath}`);
}

/** 落盘：必要时创建目录，覆写前备份。 */
export function applyPatch(plan: PatchPlan): ApplyResult {
    if ((plan.action !== 'create' && plan.action !== 'update') || plan.nextRaw === null) {
        return { written: false, backupPath: null };
    }

    fs.mkdirSync(path.dirname(plan.configPath), { recursive: true });

    let backupPath: string | null = null;
    if (plan.previousRaw !== null) {
        backupPath = resolveBackupPath(plan.configPath);
        fs.copyFileSync(plan.configPath, backupPath);
    }

    fs.writeFileSync(plan.configPath, plan.nextRaw, 'utf8');
    return { written: true, backupPath };
}

const compactJson = (value: unknown): string => JSON.stringify(value);

/**
 * 只 diff 服务器条目本身，不 diff 整个文件——我们从不改动用户的其它配置键，
 * 展示全文件 diff 只会制造噪音。
 */
export function formatEntryDiff(plan: PatchPlan): string[] {
    if (plan.action === 'create') {
        return [`      + ${compactJson(plan.nextEntry)}`];
    }
    if (plan.action === 'update' || plan.action === 'conflict') {
        return [
            `      - ${compactJson(plan.previousEntry)}`,
            `      + ${compactJson(plan.nextEntry)}`
        ];
    }
    return [];
}
