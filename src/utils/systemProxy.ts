import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

/**
 * 系统代理检测与兜底（仅当未显式配置 USE_PROXY 时生效）。
 *
 * 背景：桌面用户开了 Clash 等代理软件但未在 MCP 配置里设置 USE_PROXY/PROXY_URL 时，
 * 服务器的海外引擎探测（裸直连）会误判"不可达"。这里读取操作系统级代理设置
 * （Windows 注册表 / macOS scutil / Linux 环境变量），供探测与实际请求兜底使用。
 *
 * 优先级设计：显式配置（USE_PROXY=true + PROXY_URL + PROXY_ENGINES）完全优先，
 * 系统代理只在未显式配置时兜底；且仅海外引擎（duckduckgo/brave/startpage/exa/github）
 * 走系统代理，国内引擎保持直连（Clash 系统代理模式下国内直连更快，且绕行节点易超时）。
 */

const execFileAsync = promisify(execFile);

/** 海外引擎集合：系统代理兜底仅作用于这些引擎（与 PROXY_ENGINES 的推荐值一致） */
const OVERSEAS_ENGINES = new Set(['duckduckgo', 'brave', 'startpage', 'exa', 'github']);

export function isOverseasEngine(engine: string | undefined): boolean {
    return engine !== undefined && OVERSEAS_ENGINES.has(engine);
}

/** 缓存状态：undefined = 尚未检测，null = 检测过但无系统代理，string = 系统代理 URL */
let cachedSystemProxy: string | null | undefined;

/** 解析系统代理 URL（http://host:port），失败返回 null */
export function parseProxyUrl(proxyUrl: string): { protocol: 'http'; host: string; port: number } | null {
    try {
        const url = new URL(proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`);
        const port = url.port ? Number(url.port) : 80;
        if (!url.hostname || !Number.isFinite(port) || port <= 0 || port > 65535) {
            return null;
        }
        return { protocol: 'http', host: url.hostname, port };
    } catch {
        return null;
    }
}

async function readWindowsSystemProxy(): Promise<string | null> {
    // ProxyEnable 为 0x1 时才启用系统代理
    const { stdout: enableOut } = await execFileAsync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'
    ]);
    if (!/\s0x1\s*$/m.test(enableOut)) {
        return null;
    }
    // ProxyServer 格式：127.0.0.1:7890 或 http=127.0.0.1:7890;https=127.0.0.1:7890（分号分隔多协议）
    const { stdout: serverOut } = await execFileAsync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'
    ]);
    const serverLine = serverOut.split(/\r?\n/).find((line) => line.includes('ProxyServer')) ?? serverOut;
    const match = serverLine.match(/(?:https?=)?([^=\s;]+:\d+)/);
    return match ? match[1] : null;
}

async function readMacSystemProxy(): Promise<string | null> {
    const { stdout } = await execFileAsync('scutil', ['--proxy']);
    const parsed = JSON.parse(stdout) as { HTTPEnable?: boolean; HTTPProxy?: string; HTTPPort?: number };
    if (parsed.HTTPEnable && parsed.HTTPProxy && parsed.HTTPPort) {
        return `http://${parsed.HTTPProxy}:${parsed.HTTPPort}`;
    }
    return null;
}

function readEnvSystemProxy(): string | null {
    return process.env.https_proxy
        || process.env.http_proxy
        || process.env.HTTPS_PROXY
        || process.env.HTTP_PROXY
        || null;
}

async function readSystemProxy(): Promise<string | null> {
    try {
        if (process.platform === 'win32') {
            return await readWindowsSystemProxy();
        }
        if (process.platform === 'darwin') {
            return await readMacSystemProxy();
        }
    } catch {
        // 读取失败（reg/scutil 不存在、权限等）回退到环境变量
    }
    return readEnvSystemProxy();
}

/**
 * 检测系统代理（带缓存，进程内只检测一次）。
 * 探测流程在直连失败后调用它并缓存结果，供实际请求同步读取。
 */
export async function detectSystemProxy(): Promise<string | null> {
    if (cachedSystemProxy !== undefined) {
        return cachedSystemProxy;
    }
    const detected = await readSystemProxy();
    // 统一规范化为带协议的完整 URL（Windows 注册表 ProxyServer 常为 "host:port" 无协议前缀，
    // HttpsProxyAgent 需要完整 URL）；格式非法时视为无系统代理
    const normalized = detected && parseProxyUrl(detected)
        ? (detected.includes('://') ? detected : `http://${detected}`)
        : null;
    cachedSystemProxy = normalized;
    return normalized;
}

/** 同步读取已检测的系统代理（未检测时为 null；调用方应先 await detectSystemProxy） */
export function getDetectedSystemProxy(): string | null {
    return cachedSystemProxy ?? null;
}

/**
 * 系统代理兜底 URL（encodeURI 后，与 getProxyUrl 格式一致）：
 * - 显式配置了 USE_PROXY → 不参与（返回 undefined，显式路径完全优先）
 * - 未显式配置 + 检测到系统代理 + 海外引擎（或未指定引擎的通用抓取）→ 返回系统代理 URL
 * - 国内引擎（bing/baidu/sogou/csdn/juejin/context7 等）→ undefined（保持直连）
 */
export function getSystemProxyFallbackUrl(engine?: string): string | undefined {
    if (config.useProxy) {
        return undefined;
    }
    const sysProxy = getDetectedSystemProxy();
    if (!sysProxy) {
        return undefined;
    }
    if (engine === undefined || isOverseasEngine(engine)) {
        return encodeURI(sysProxy);
    }
    return undefined;
}
