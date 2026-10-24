import { inspect } from 'node:util';

/**
 * 统一日志入口。
 *
 * - 级别：debug < info < warn < error < silent，由 LOG_LEVEL 控制；
 * - 输出统一走 stderr，保证 CLI `--json` 的 stdout 只有结构化结果；
 * - 兼容存量代码：`installConsoleBridge()` 在 CLI/MCP 入口把 console.* 接到这里，
 *   不需要一次性改动 180+ 个调用点（测试不安装，避免影响 console spy）。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
};

let currentLevel: LogLevel = 'info';
let currentPrefix = 'my-websearch';
let bridgeInstalled = false;

function parseLevel(raw: string | undefined): LogLevel | undefined {
    const value = raw?.trim().toLowerCase();
    if (!value) {
        return undefined;
    }
    if (value === 'quiet') {
        return 'warn';
    }
    if (value === 'normal') {
        return 'info';
    }
    if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'silent') {
        return value;
    }
    return undefined;
}

export function resolveLogLevel(explicit?: string, quietStartup = false): LogLevel {
    return parseLevel(explicit) ?? (quietStartup ? 'warn' : 'info');
}

export function configureLogging(options: { level?: string; prefix?: string; quietStartup?: boolean } = {}): void {
    currentLevel = resolveLogLevel(options.level ?? process.env.LOG_LEVEL, options.quietStartup);
    if (options.prefix) {
        currentPrefix = options.prefix;
    }
}

export function isLevelEnabled(level: Exclude<LogLevel, 'silent'>): boolean {
    if (currentLevel === 'silent') {
        return false;
    }
    return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function formatArg(arg: unknown): string {
    if (typeof arg === 'string') {
        return arg;
    }
    if (arg instanceof Error) {
        return arg.stack ?? arg.message;
    }
    return inspect(arg, { depth: 3, breakLength: 120 });
}

function emit(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
    if (!isLevelEnabled(level)) {
        return;
    }
    const text = args.map(formatArg).join(' ');
    process.stderr.write(`[${level}] [${currentPrefix}] ${text}\n`);
}

export const log = {
    debug: (...args: unknown[]): void => emit('debug', args),
    info: (...args: unknown[]): void => emit('info', args),
    warn: (...args: unknown[]): void => emit('warn', args),
    error: (...args: unknown[]): void => emit('error', args)
};

/**
 * 把存量 console.debug/info/warn/error 统一接到 stderr + level 过滤。
 * 故意不接管 console.log：CLI 的 stdout 写入（包括 --json）必须保持纯净。
 */
export function installConsoleBridge(): void {
    if (bridgeInstalled) {
        return;
    }
    bridgeInstalled = true;
    const methods = ['debug', 'info', 'warn', 'error'] as const;
    for (const method of methods) {
        (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (...args: unknown[]) => {
            if (!isLevelEnabled(method)) {
                return;
            }
            emit(method, args);
        };
    }
}

/** 测试/诊断用：恢复 bridge 状态（不恢复 console 原函数，进程内只安装一次） */
export function __resetLogStateForTests(): void {
    currentLevel = 'info';
    currentPrefix = 'my-websearch';
}
