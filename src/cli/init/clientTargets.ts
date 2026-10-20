import fs from 'node:fs';
import path from 'node:path';

/**
 * `my-websearch init` 的客户端目标定义。
 *
 * 这里只放**纯数据 + 纯函数**（不读全局、不写文件），
 * 目的是让平台差异、路径规则、npx 兜底策略都能被单测直接覆盖。
 */

/** 写入配置时使用的规范键名（与 README 一致）。 */
export const CANONICAL_SERVER_KEY = 'my-websearch';

/**
 * 历史版本 / 其他发行渠道可能用过的键名。
 * 命中任何一个都视为「本服务器已存在」，避免同一个客户端里出现两份重复条目。
 */
export const SERVER_KEY_ALIASES: readonly string[] = [
    CANONICAL_SERVER_KEY,
    'mywebsearch',
    'open-websearch',
    'open-webSearch'
];

export type ClientId = 'claude-desktop' | 'cursor' | 'vscode';

/**
 * 配置文档中服务器条目的挂载方式：
 * - `mcpServers`：Claude Desktop / Cursor 的 `{"mcpServers": {...}}`
 * - `servers`：VS Code 的 `.vscode/mcp.json`（注意：文件本身就是配置根，没有 `mcp` 外层）
 */
export type ConfigShape = 'mcpServers' | 'servers';

export type ClientTarget = {
    id: ClientId;
    label: string;
    shape: ConfigShape;
    /** 返回该客户端在本机的配置文件绝对路径；返回 null 表示当前平台无意义 */
    configPath: (host: InitHost) => string | null;
    /** 是否属于「工作区级」配置（只在当前项目目录生效） */
    workspaceScoped: boolean;
};

export type InitHost = {
    home: string;
    cwd: string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
};

export type LaunchCommand = {
    command: string;
    args: string[];
    /** 生成配置时需要提醒用户的问题（例如 npx 不可用） */
    warning?: string;
};

const appDataDir = (host: InitHost): string | null => {
    const fromEnv = host.env.APPDATA || host.env.AppData;
    if (fromEnv) {
        return fromEnv;
    }
    if (host.platform === 'win32') {
        return path.join(host.home, 'AppData', 'Roaming');
    }
    return null;
};

const claudeDesktopConfigPath = (host: InitHost): string | null => {
    if (host.platform === 'darwin') {
        return path.join(host.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    if (host.platform === 'win32') {
        const base = appDataDir(host);
        return base ? path.join(base, 'Claude', 'claude_desktop_config.json') : null;
    }
    return path.join(host.home, '.config', 'Claude', 'claude_desktop_config.json');
};

const cursorConfigPath = (host: InitHost): string => path.join(host.home, '.cursor', 'mcp.json');

/**
 * VS Code 只写工作区级 `.vscode/mcp.json`。
 *
 * 刻意不碰用户级 `settings.json`：那是 JSONC（允许注释和尾逗号），
 * 用 JSON.parse 读会直接失败，强行改写有损坏用户编辑器设置的风险。
 */
const vscodeConfigPath = (host: InitHost): string => path.join(host.cwd, '.vscode', 'mcp.json');

export const CLIENT_TARGETS: readonly ClientTarget[] = [
    {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        shape: 'mcpServers',
        configPath: claudeDesktopConfigPath,
        workspaceScoped: false
    },
    {
        id: 'cursor',
        label: 'Cursor',
        shape: 'mcpServers',
        configPath: cursorConfigPath,
        workspaceScoped: false
    },
    {
        id: 'vscode',
        label: 'VS Code',
        shape: 'servers',
        configPath: vscodeConfigPath,
        workspaceScoped: true
    }
];

export const CLIENT_IDS: readonly ClientId[] = CLIENT_TARGETS.map((target) => target.id);

export const CLIENT_ALIASES: Readonly<Record<string, ClientId>> = {
    claude: 'claude-desktop',
    'claude-desktop': 'claude-desktop',
    claudedesktop: 'claude-desktop',
    cursor: 'cursor',
    vscode: 'vscode',
    code: 'vscode',
    'vs-code': 'vscode'
};

const executableNames = (platform: NodeJS.Platform): readonly string[] => (
    platform === 'win32' ? ['npx.cmd', 'npx.exe', 'npx'] : ['npx']
);

/**
 * 在 `execPath` 所在目录和 PATH 中查找 npx，仅用于**生成警告**，不改变实际写入的命令。
 * 不做这一步的话，用户要等到客户端启动失败才知道本机没有 node。
 */
export function findNpxBinary(host: InitHost, execPath: string): string | null {
    const separator = host.platform === 'win32' ? ';' : ':';
    const pathValue = host.env.PATH || host.env.Path || '';
    const directories = [
        path.dirname(execPath),
        ...pathValue.split(separator).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean)
    ];

    for (const directory of directories) {
        for (const name of executableNames(host.platform)) {
            const candidate = path.join(directory, name);
            try {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            } catch {
                // 无权限 / 非法路径：继续找下一个
            }
        }
    }
    return null;
}

const npxMissingWarning = (): string => (
    '找不到 npx：请确认已安装 Node.js 20+ 且 npx 在 PATH 中，否则客户端启动服务器时会直接失败。'
);

/**
 * 生成写入客户端配置的启动命令。
 *
 * 平台差异（这是 init 最想一次性解决的问题）：
 * - Windows：走 `cmd /c npx`。`npx` 实际是 `npx.cmd` 批处理垫片，
 *   直接 spawn 一个 `.cmd` 在部分客户端/Node 版本下会 ENOENT 或需要 shell，
 *   README 里原本只是让用户自己判断「npx 不在 PATH 时改用 cmd /c」。
 * - 其他平台：直接用 `npx`，不写死绝对路径——nvm/fnm 用户升级 Node 后
 *   绝对路径会失效，反而制造更难排查的问题；PATH 问题交给 `doctor` 兜底提示。
 */
export function buildLaunchCommand(host: InitHost, execPath: string): LaunchCommand {
    const npxPath = findNpxBinary(host, execPath);
    const baseArgs = ['-y', 'my-websearch@latest'];
    const warning = npxPath ? undefined : npxMissingWarning();

    if (host.platform === 'win32') {
        const command: LaunchCommand = {
            command: 'cmd',
            args: ['/c', 'npx', ...baseArgs]
        };
        if (warning) {
            command.warning = warning;
        }
        return command;
    }

    const command: LaunchCommand = {
        command: 'npx',
        args: baseArgs
    };
    if (warning) {
        command.warning = warning;
    }
    return command;
}

/** 生成写入配置的服务器条目。 */
export function buildServerEntry(launch: LaunchCommand): Record<string, unknown> {
    return {
        command: launch.command,
        args: [...launch.args],
        env: { MODE: 'stdio' }
    };
}

export function parseClientIds(raw: string): ClientId[] {
    const requested = raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    if (requested.length === 0) {
        throw new Error('--client requires at least one client name');
    }
    if (requested.includes('all')) {
        return [...CLIENT_IDS];
    }

    const resolved = new Set<ClientId>();
    for (const entry of requested) {
        const id = CLIENT_ALIASES[entry];
        if (!id) {
            throw new Error(
                `Unknown client "${entry}". Valid clients: ${CLIENT_IDS.join(', ')}, or "all".`
            );
        }
        resolved.add(id);
    }
    return [...resolved];
}
