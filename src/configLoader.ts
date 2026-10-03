import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface MyWebSearchConfigFile {
    apiKeys?: {
        context7?: string;
        exa?: string;
        github?: string;
        brave?: string;
        [key: string]: string | undefined;
    };
    proxy?: {
        url?: string;
        useProxy?: boolean;
        enabled?: boolean;
        engines?: string[] | string;
        fakeIpCidrs?: string[] | string;
    };
    [key: string]: unknown;
}

/**
 * 内部轻量 .env 解析器（无需引入外部 dotenv 依赖）
 */
export function parseDotEnv(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        // 去除外层单/双引号
        if (
            (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
            (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
        ) {
            val = val.slice(1, -1);
        }
        if (key) {
            result[key] = val;
        }
    }
    return result;
}

/**
 * 获取应用级数据目录（默认 ~/.my-websearch，支持 MYWEBSEARCH_DATA_DIR 环境变量覆盖）
 */
export function getAppConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.MYWEBSEARCH_DATA_DIR || path.join(os.homedir(), '.my-websearch');
}

/**
 * 获取应用级配置文件路径（~/.my-websearch/config.json）
 */
export function getAppConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(getAppConfigDir(env), 'config.json');
}

/**
 * 将结构化 JSON 配置展平映射为标准环境变量
 */
export function flattenConfigFileToEnv(configData: MyWebSearchConfigFile): Record<string, string> {
    const flat: Record<string, string> = {};

    // 1. apiKeys 映射
    if (configData.apiKeys && typeof configData.apiKeys === 'object') {
        const keys = configData.apiKeys;
        if (keys.context7) flat.CONTEXT7_API_KEY = keys.context7;
        if (keys.exa) flat.EXA_API_KEY = keys.exa;
        if (keys.github) flat.GITHUB_TOKEN = keys.github;
        if (keys.brave) flat.BRAVE_API_KEY = keys.brave;

        // 扁平大写兜底
        for (const [k, v] of Object.entries(keys)) {
            if (typeof v === 'string' && v.trim()) {
                if (k.toUpperCase().includes('KEY') || k.toUpperCase().includes('TOKEN')) {
                    flat[k.toUpperCase()] = v.trim();
                }
            }
        }
    }

    // 2. proxy 映射
    if (configData.proxy && typeof configData.proxy === 'object') {
        const p = configData.proxy;
        if (p.url) flat.PROXY_URL = p.url;
        if (p.useProxy !== undefined) {
            flat.USE_PROXY = p.useProxy ? 'true' : 'false';
        } else if (p.enabled !== undefined) {
            flat.USE_PROXY = p.enabled ? 'true' : 'false';
        }
        if (p.engines) {
            flat.PROXY_ENGINES = Array.isArray(p.engines) ? p.engines.join(',') : p.engines;
        }
        if (p.fakeIpCidrs) {
            flat.FAKE_IP_CIDRS = Array.isArray(p.fakeIpCidrs) ? p.fakeIpCidrs.join(',') : p.fakeIpCidrs;
        }
    }

    // 3. 根节点顶层扁平环境变量兼容
    for (const [k, v] of Object.entries(configData)) {
        if (typeof v === 'string' && v.trim() && k === k.toUpperCase() && !flat[k]) {
            flat[k] = v.trim();
        }
    }

    return flat;
}

/**
 * 首次引导：若 ~/.my-websearch/config.json 不存在，尝试从已有的 Agent 配置（Antigravity/WorkBuddy）初始化
 */
function tryAutoBootstrapConfig(targetPath: string): MyWebSearchConfigFile | null {
    const home = os.homedir();
    const candidateFiles = [
        path.join(home, '.gemini', 'config', 'mcp_config.json'),
        path.join(home, '.workbuddy', 'mcp.json'),
    ];

    for (const cand of candidateFiles) {
        try {
            const raw = fs.readFileSync(cand, 'utf8');
            const parsed = JSON.parse(raw);
            const servers = parsed?.mcpServers || {};
            const serverConfig = servers['mywebsearch'] || servers['open-websearch'] || servers['open-webSearch'];
            const env = serverConfig?.env;
            if (env && typeof env === 'object') {
                const apiKeys: Record<string, string> = {};
                if (env.CONTEXT7_API_KEY) apiKeys.context7 = env.CONTEXT7_API_KEY;
                if (env.EXA_API_KEY) apiKeys.exa = env.EXA_API_KEY;
                if (env.GITHUB_TOKEN) apiKeys.github = env.GITHUB_TOKEN;
                if (env.BRAVE_API_KEY) apiKeys.brave = env.BRAVE_API_KEY;

                const proxy: Record<string, unknown> = {};
                if (env.PROXY_URL) proxy.url = env.PROXY_URL;
                if (env.USE_PROXY !== undefined) proxy.useProxy = env.USE_PROXY === 'true';
                if (env.PROXY_ENGINES) {
                    proxy.engines = env.PROXY_ENGINES.split(',').map((s: string) => s.trim()).filter(Boolean);
                }

                if (Object.keys(apiKeys).length > 0 || Object.keys(proxy).length > 0) {
                    const bootstrapped: MyWebSearchConfigFile = {
                        apiKeys,
                        ...(Object.keys(proxy).length > 0 ? { proxy } : {})
                    };

                    const parentDir = path.dirname(targetPath);
                    try {
                        fs.mkdirSync(parentDir, { recursive: true });
                    } catch {
                        // ignore directory creation error
                    }
                    fs.writeFileSync(targetPath, JSON.stringify(bootstrapped, null, 2), 'utf8');
                    return bootstrapped;
                }
            }
        } catch {
            // 忽略文件不存在或解析错误
        }
    }

    return null;
}

/**
 * 统一加载应用级配置，并将缺失的配置填补（fill-missing）写入 targetEnv（默认 process.env）
 * 优先级：
 *   1. targetEnv 现有变量（最高优先级，绝不覆盖）
 *   2. 项目根目录 .env / .my-websearch.json
 *   3. ~/.my-websearch/config.json（支持 MYWEBSEARCH_DATA_DIR）
 *
 * @returns 本次被填充注入的新环境变量键值对
 */
export function loadApplicationConfigEnv(
    targetEnv: NodeJS.ProcessEnv = process.env,
    options: { cwd?: string; quiet?: boolean } = {}
): Record<string, string> {
    const cwd = options.cwd || process.cwd();
    const candidateEnv: Record<string, string> = {};

    // 1. 读取项目根目录 .env（直接读取，免去多余的 stat 系统调用）
    const dotEnvPath = path.join(cwd, '.env');
    try {
        const content = fs.readFileSync(dotEnvPath, 'utf8');
        const parsed = parseDotEnv(content);
        Object.assign(candidateEnv, parsed);
    } catch {
        // 忽略文件不存在或读取错误
    }

    // 2. 读取项目根目录 .my-websearch.json
    const projectJsonPath = path.join(cwd, '.my-websearch.json');
    try {
        const raw = fs.readFileSync(projectJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        const flat = flattenConfigFileToEnv(parsed);
        // .env 优先于 .my-websearch.json，仅补缺失
        for (const [k, v] of Object.entries(flat)) {
            if (!candidateEnv[k]) candidateEnv[k] = v;
        }
    } catch {
        // 忽略文件不存在或读取错误
    }

    // 3. 读取用户主目录应用级配置文件 ~/.my-websearch/config.json
    const appConfigPath = getAppConfigFilePath(targetEnv);
    let appConfigData: MyWebSearchConfigFile | null = null;

    try {
        const raw = fs.readFileSync(appConfigPath, 'utf8');
        appConfigData = JSON.parse(raw);
    } catch (err: unknown) {
        // 文件不存在时尝试自动从现有 Agent 配置初始化
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            appConfigData = tryAutoBootstrapConfig(appConfigPath);
        }
    }

    if (appConfigData) {
        const flat = flattenConfigFileToEnv(appConfigData);
        for (const [k, v] of Object.entries(flat)) {
            if (!candidateEnv[k]) candidateEnv[k] = v;
        }
    }

    // 4. 将 candidateEnv 中有值但 targetEnv 中未定义的项补齐到 targetEnv（已定义的空串亦视为显式指定，不覆盖）
    const injected: Record<string, string> = {};
    for (const [key, value] of Object.entries(candidateEnv)) {
        if (value && targetEnv[key] === undefined) {
            targetEnv[key] = value;
            injected[key] = value;
        }
    }

    // 打印引导提示（非静默且非测试环境，且确实有关键配置注入时）
    if (!options.quiet && targetEnv.NODE_ENV !== 'test' && Object.keys(injected).length > 0) {
        const injectedKeyNames = Object.keys(injected).filter((k) =>
            k.includes('KEY') || k.includes('TOKEN') || k.includes('PROXY')
        );
        if (injectedKeyNames.length > 0 && targetEnv.OPEN_WEBSEARCH_QUIET_STARTUP !== 'true') {
            // 仅对测试/调试环境输出提示（不在 stdio 污染 stdout）
            console.error(`⚙️ [config] Auto-loaded config from ~/.my-websearch/config.json: ${injectedKeyNames.join(', ')}`);
        }
    }

    return injected;
}
