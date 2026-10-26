import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LaunchOptions } from './driver.js';

let cachedExecutablePath: string | null = null;

export function resetCachedBrowserPath(): void {
    cachedExecutablePath = null;
}

/**
 * 自动定位本机已安装的 Chromium 系浏览器（Chrome / Edge）。
 * 优先级：
 * 1. 显式传入或配置项路径（保留旧配置 playwrightExecutablePath 兼容）
 * 2. 环境变量 CHROME_PATH / BROWSER_PATH
 * 3. 操作系统标准安装路径（Windows、Linux、macOS）
 */
export function findChromeExecutable(customPath?: string): string {
    if (customPath && fs.existsSync(customPath)) {
        return customPath;
    }

    const envPath = process.env.CHROME_PATH || process.env.BROWSER_PATH;
    if (envPath && fs.existsSync(envPath)) {
        return envPath;
    }

    if (cachedExecutablePath && fs.existsSync(cachedExecutablePath)) {
        return cachedExecutablePath;
    }

    const candidates: string[] = [];

    // Windows 常见路径（优先 Google Chrome，后回退 Microsoft Edge）
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

    const pf = process.env['PROGRAMFILES'];
    const pf86 = process.env['PROGRAMFILES(X86)'];
    const localAppData = process.env['LOCALAPPDATA'];
    if (pf) {
        candidates.push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`);
        candidates.push(`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
    }
    if (pf86) {
        candidates.push(`${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
        candidates.push(`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`);
    }
    if (localAppData) {
        candidates.push(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`);
        candidates.push(`${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`);
    }

    // Linux 常见路径
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/microsoft-edge');

    // macOS 常见路径
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');

    for (const candidate of [...new Set(candidates)]) {
        if (fs.existsSync(candidate)) {
            cachedExecutablePath = candidate;
            return candidate;
        }
    }

    throw new Error('No Chromium-based browser executable was found. Set CHROME_PATH, BROWSER_PATH, or install Google Chrome / Microsoft Edge.');
}

/**
 * 杀死进程树（跨平台）。
 * 在 Windows 上必须使用 taskkill /T /F 杀死子进程树，避免遗留孤儿 chrome.exe 进程。
 */
export async function killProcessTree(pid: number): Promise<void> {
    if (!pid || pid <= 0) {
        return;
    }

    if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
            execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
        });
    } else {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // process already dead
            }
        }
    }
}

/**
 * 解析 DevToolsActivePort 文件的内容。
 * 第 1 行：端口号（1-65535）
 * 第 2 行：Browser target WebSocket 路径
 */
export function parseDevToolsActivePort(content: string): { port: number; wsPath: string } {
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) {
        throw new Error('DevToolsActivePort content is invalid: missing port or ws path');
    }
    const port = Number.parseInt(lines[0]!, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid DevTools port: ${lines[0]}`);
    }
    return { port, wsPath: lines[1]! };
}

/**
 * 构造 Chrome / Edge 进程启动参数。
 */
export function buildChromeArgs(options: LaunchOptions, tempDir: string): string[] {
    const flags: string[] = [
        options.headless !== false ? '--headless=new' : '',
        '--remote-debugging-port=0',
        `--user-data-dir=${tempDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-default-apps',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-crash-dump',
        '--remote-allow-origins=*'
    ].filter(Boolean);

    if (options.proxy?.server) {
        flags.push(`--proxy-server=${options.proxy.server}`);
        if (options.proxy.bypass) {
            flags.push(`--proxy-bypass-list=${options.proxy.bypass}`);
        }
    }

    // 不要默认加 --no-sandbox，仅在明确配置或 root 环境使用
    if (process.env.CHROME_NO_SANDBOX === 'true' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
        flags.push('--no-sandbox');
    }

    if (options.args && options.args.length > 0) {
        const extraArgs = options.args.filter((arg) => !arg.startsWith('--user-data-dir='));
        flags.push(...extraArgs);
    }

    return flags;
}

/**
 * 等待并读取 Chromium 生成的 DevToolsActivePort 文件，解析动态分配的端口。
 */
export async function readDevToolsActivePort(userDataDir: string, timeoutMs = 30000): Promise<{ port: number; wsPath: string }> {
    const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (fs.existsSync(activePortFile)) {
            try {
                const text = readFileSync(activePortFile, 'utf8');
                return parseDevToolsActivePort(text);
            } catch {
                // 文件可能正在写入，稍后重试
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out waiting for DevToolsActivePort in ${userDataDir} after ${timeoutMs}ms`);
}

export interface LaunchedChrome {
    proc: ChildProcess;
    port: number;
    wsPath: string;
    tempDir: string;
    cleanup(): Promise<void>;
}

/**
 * 启动无头 Chrome 进程并配置 DevTools 端口与隔离临时目录。
 */
export async function launchChromeProcess(options: LaunchOptions = {}): Promise<LaunchedChrome> {
    const executablePath = findChromeExecutable(options.executablePath);
    const explicitUserDirArg = options.args?.find((a) => a.startsWith('--user-data-dir='));
    const tempDir = options.userDataDir || (explicitUserDirArg ? explicitUserDirArg.slice('--user-data-dir='.length) : mkdtempSync(path.join(tmpdir(), 'my-websearch-cdp-')));
    const flags = buildChromeArgs(options, tempDir);

    const proc = spawn(executablePath, flags, {
        stdio: 'ignore',
        windowsHide: true,
        detached: process.platform !== 'win32'
    });

    if (!proc.pid) {
        throw new Error(`Failed to spawn browser process from ${executablePath}`);
    }

    const pid = proc.pid;
    let cleanedUp = false;

    const cleanup = async () => {
        if (cleanedUp) {
            return;
        }
        cleanedUp = true;

        try {
            proc.kill();
        } catch {
            // ignore
        }

        await killProcessTree(pid);

        // 删除临时 profile 目录（在 Windows 上文件锁释放需要一定重试）
        if (tempDir && fs.existsSync(tempDir)) {
            for (let i = 0; i < 5; i++) {
                try {
                    rmSync(tempDir, { recursive: true, force: true });
                    break;
                } catch {
                    await new Promise((r) => setTimeout(r, 100));
                }
            }
        }
    };

    try {
        const { port, wsPath } = await readDevToolsActivePort(tempDir, options.timeoutMs ?? 30000);
        return {
            proc,
            port,
            wsPath,
            tempDir,
            cleanup
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
