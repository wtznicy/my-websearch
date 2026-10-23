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

export type ConfigValueSource = 'process_env' | 'dot_env' | 'project_config_json' | 'app_config_json';

export interface ConfigLoadSnapshot {
    initialEnvKeys: Set<string>;
    injectedValues: Record<string, string>;
    injectedSources: Record<string, ConfigValueSource>;
}

const envLoadSnapshots = new WeakMap<NodeJS.ProcessEnv, ConfigLoadSnapshot>();

export function getConfigLoadSnapshot(targetEnv: NodeJS.ProcessEnv = process.env): ConfigLoadSnapshot | undefined {
    return envLoadSnapshots.get(targetEnv);
}

/**
 * 将结构化 JSON 配置展平映射为标准环境变量
 */
export function flattenConfigFileToEnv(
    configData: MyWebSearchConfigFile,
    options?: { onWarning?: (message: string) => void }
): Record<string, string> {
    const flat: Record<string, string> = {};

    // 1. apiKeys 映射
    if (configData.apiKeys && typeof configData.apiKeys === 'object') {
        const keys = configData.apiKeys;
        if (typeof keys.context7 === 'string') flat.CONTEXT7_API_KEY = keys.context7.trim();
        if (typeof keys.exa === 'string') flat.EXA_API_KEY = keys.exa.trim();
        if (typeof keys.github === 'string') flat.GITHUB_TOKEN = keys.github.trim();
        if (typeof keys.brave === 'string') flat.BRAVE_API_KEY = keys.brave.trim();
        if (typeof keys.stackoverflow === 'string') flat.STACKOVERFLOW_API_KEY = keys.stackoverflow.trim();
        if (typeof keys.stackexchange === 'string') flat.STACKOVERFLOW_API_KEY = keys.stackexchange.trim();

        // 扁平大写兜底
        for (const [k, v] of Object.entries(keys)) {
            if (typeof v === 'string') {
                const upper = k.toUpperCase();
                if ((upper.includes('KEY') || upper.includes('TOKEN')) && !Object.prototype.hasOwnProperty.call(flat, upper)) {
                    flat[upper] = v.trim();
                }
            }
        }
    }

    // 2. proxy 映射
    if (configData.proxy && typeof configData.proxy === 'object') {
        const p = configData.proxy;
        if (p.useProxy === false || p.enabled === false) {
            if (typeof p.url === 'string' && p.url.trim().length > 0 && !/^(false|none|off|0|direct|no)$/i.test(p.url.trim())) {
                options?.onWarning?.(
                    `⚠️ [config] proxy.url ("${p.url.trim()}") is configured, but proxy.useProxy is false — proxy remains disabled. Set "useProxy": true (or remove "useProxy": false) to enable it.`
                );
            }
            flat.PROXY_URL = 'false';
            flat.USE_PROXY = 'false';
        } else {
            if (typeof p.url === 'string') flat.PROXY_URL = p.url.trim();
            if (p.useProxy !== undefined) {
                flat.USE_PROXY = p.useProxy ? 'true' : 'false';
            } else if (p.enabled !== undefined) {
                flat.USE_PROXY = p.enabled ? 'true' : 'false';
            }
        }
        if (p.engines !== undefined) {
            flat.PROXY_ENGINES = Array.isArray(p.engines) ? p.engines.join(',') : String(p.engines);
        }
        if (p.fakeIpCidrs !== undefined) {
            flat.FAKE_IP_CIDRS = Array.isArray(p.fakeIpCidrs) ? p.fakeIpCidrs.join(',') : String(p.fakeIpCidrs);
        }
    }

    // 2.5. search 映射
    if (configData.search && typeof configData.search === 'object') {
        const s = configData.search as Record<string, unknown>;
        if (s.autoRouteEnEngines !== undefined) {
            flat.AUTO_ROUTE_EN_ENGINES = Array.isArray(s.autoRouteEnEngines) ? s.autoRouteEnEngines.join(',') : String(s.autoRouteEnEngines);
        }
        if (s.autoRouteZhEngines !== undefined) {
            flat.AUTO_ROUTE_ZH_ENGINES = Array.isArray(s.autoRouteZhEngines) ? s.autoRouteZhEngines.join(',') : String(s.autoRouteZhEngines);
        }
    }

    // 3. 根节点顶层扁平环境变量兼容
    for (const [k, v] of Object.entries(configData)) {
        if (typeof v === 'string' && k === k.toUpperCase() && !Object.prototype.hasOwnProperty.call(flat, k)) {
            flat[k] = v.trim();
        }
    }

    return flat;
}

export function sanitizePathForLog(filePath: string): string {
    if (!filePath || !filePath.trim()) {
        return filePath;
    }
    const home = os.homedir();
    if (!home) {
        return filePath;
    }
    const normalizedHome = home.replace(/\\/g, '/');
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath.toLowerCase().startsWith(normalizedHome.toLowerCase())) {
        return `~${normalizedPath.slice(normalizedHome.length)}`;
    }
    return filePath;
}

export function shouldEmitConfigStartupLog(targetEnv: NodeJS.ProcessEnv, quiet?: boolean): boolean {
    if (quiet === true) {
        return false;
    }
    const debugTestLogs = targetEnv.DEBUG_TEST_LOGS === 'true' || process.env.DEBUG_TEST_LOGS === 'true';
    if (debugTestLogs || quiet === false) {
        return true;
    }
    if (
        targetEnv.OPEN_WEBSEARCH_QUIET_STARTUP === 'true'
        || process.env.OPEN_WEBSEARCH_QUIET_STARTUP === 'true'
        || (targetEnv.LOG_LEVEL ?? process.env.LOG_LEVEL ?? '').toLowerCase() === 'quiet'
    ) {
        return false;
    }
    const isStandaloneTestRunner = Boolean(process.argv[1] && /[\\/]test[\\/]/i.test(process.argv[1]));
    const isTestEnv = targetEnv.NODE_ENV === 'test'
        || process.env.NODE_ENV === 'test'
        || targetEnv.VITEST === 'true'
        || process.env.VITEST === 'true'
        || targetEnv.MODE === 'test'
        || isStandaloneTestRunner;
    return !isTestEnv;
}

/**
 * 首次引导：若 ~/.my-websearch/config.json 不存在，尝试从已有的 Agent 配置（Antigravity/WorkBuddy）初始化
 */
function tryAutoBootstrapConfig(
    targetPath: string,
    options: { quiet?: boolean; targetEnv?: NodeJS.ProcessEnv } = {}
): MyWebSearchConfigFile | null {
    // P2-20：默认仍然自动引导（保持零配置体验），但必须可关闭——
    // 「把别的应用里的密钥复制到本应用目录」对安全敏感用户是意外行为。
    if (process.env.MYWEBSEARCH_NO_AUTO_BOOTSTRAP === '1') {
        return null;
    }
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
                    fs.writeFileSync(targetPath, JSON.stringify(bootstrapped, null, 2), { encoding: 'utf8', mode: 0o600 });
                    if (shouldEmitConfigStartupLog(options.targetEnv ?? process.env, options.quiet)) {
                        console.error(`ℹ️ [config] Auto-bootstrapped configuration from ${sanitizePathForLog(cand)} to ${sanitizePathForLog(targetPath)}`);
                    }
                    return bootstrapped;
                }
            }
        } catch {
            // 忽略文件不存在或解析错误
        }
    }

    return null;
}

function mergeLowerPriorityEnv(
    candidateEnv: Record<string, string>,
    candidateSources: Record<string, ConfigValueSource>,
    incoming: Record<string, string>,
    source: ConfigValueSource
): void {
    const hasHigherProxyUrl = Object.prototype.hasOwnProperty.call(candidateEnv, 'PROXY_URL')
        && candidateSources.PROXY_URL !== source;
    const hasHigherUseProxy = Object.prototype.hasOwnProperty.call(candidateEnv, 'USE_PROXY')
        && candidateSources.USE_PROXY !== source;

    for (const [k, v] of Object.entries(incoming)) {
        if (Object.prototype.hasOwnProperty.call(candidateEnv, k)) {
            continue;
        }
        if (hasHigherProxyUrl && (k === 'USE_PROXY' || k === 'PROXY_ENGINES')) {
            continue;
        }
        if (hasHigherUseProxy && k === 'PROXY_URL') {
            continue;
        }
        candidateEnv[k] = v;
        candidateSources[k] = source;
    }
}

/**
 * 统一加载应用级配置，并将缺失的配置填补（fill-missing）写入 targetEnv（默认 process.env）
 * 优先级：
 *   1. targetEnv 现有变量（最高优先级，绝不覆盖）
 *   2. 项目根目录 .env
 *   3. 项目根目录 .my-websearch.json
 *   4. ~/.my-websearch/config.json（支持 MYWEBSEARCH_DATA_DIR）
 *
 * @returns 本次被填充注入的新环境变量键值对
 */
export function loadApplicationConfigEnv(
    targetEnv: NodeJS.ProcessEnv = process.env,
    options: { cwd?: string; quiet?: boolean } = {}
): Record<string, string> {
    const cwd = options.cwd || process.cwd();
    const candidateEnv: Record<string, string> = {};
    const candidateSources: Record<string, ConfigValueSource> = {};

    // 1. 读取项目根目录 .env（直接读取，免去多余的 stat 系统调用）
    const dotEnvPath = path.join(cwd, '.env');
    try {
        const content = fs.readFileSync(dotEnvPath, 'utf8');
        const parsed = parseDotEnv(content);
        for (const [k, v] of Object.entries(parsed)) {
            candidateEnv[k] = v;
            candidateSources[k] = 'dot_env';
        }
    } catch {
        // 忽略文件不存在或读取错误
    }

    const configWarnings: string[] = [];
    const onWarning = (msg: string) => {
        if (!configWarnings.includes(msg)) {
            configWarnings.push(msg);
        }
    };

    // 2. 读取项目根目录 .my-websearch.json
    const projectJsonPath = path.join(cwd, '.my-websearch.json');
    try {
        const raw = fs.readFileSync(projectJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        const flat = flattenConfigFileToEnv(parsed, { onWarning });
        // .env 优先于 .my-websearch.json，按 key 是否已出现判断缺失（保留高优先级显式空字符串）
        mergeLowerPriorityEnv(candidateEnv, candidateSources, flat, 'project_config_json');
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
            appConfigData = tryAutoBootstrapConfig(appConfigPath, {
                quiet: options.quiet,
                targetEnv
            });
        }
    }

    if (appConfigData) {
        const flat = flattenConfigFileToEnv(appConfigData, { onWarning });
        mergeLowerPriorityEnv(candidateEnv, candidateSources, flat, 'app_config_json');
    }

    if (configWarnings.length > 0 && shouldEmitConfigStartupLog(targetEnv, options.quiet)) {
        for (const warning of configWarnings) {
            console.warn(warning);
        }
    }

    // 4. 注入前保存原始环境变量键集合快照，按快照判断调用方显式覆盖，
    // 避免同一配置文件在注入 PROXY_URL 后把自身注入的值误判为外部显式配置而跳过同源的 USE_PROXY / PROXY_ENGINES
    const currentDefinedKeys = new Set(
        Object.keys(targetEnv).filter((k) => Object.prototype.hasOwnProperty.call(targetEnv, k) && targetEnv[k] !== undefined)
    );
    const existingSnapshot = envLoadSnapshots.get(targetEnv);
    const snapshot: ConfigLoadSnapshot = existingSnapshot ?? {
        initialEnvKeys: new Set(currentDefinedKeys),
        injectedValues: {},
        injectedSources: {}
    };

    const injected: Record<string, string> = {};
    for (const [key, value] of Object.entries(candidateEnv)) {
        if (Object.prototype.hasOwnProperty.call(candidateEnv, key) && !currentDefinedKeys.has(key)) {
            // 若外部环境变量已显式指定了 PROXY_URL，则配置文件中的 USE_PROXY / PROXY_ENGINES 不再补入，避免干扰外部显式合并变量
            if (currentDefinedKeys.has('PROXY_URL') && (key === 'USE_PROXY' || key === 'PROXY_ENGINES')) {
                continue;
            }
            // 同理，若外部环境变量已显式指定了 USE_PROXY，配置文件中的 PROXY_URL 不应反向覆盖显式意图
            if (currentDefinedKeys.has('USE_PROXY') && key === 'PROXY_URL') {
                continue;
            }
            targetEnv[key] = value;
            injected[key] = value;
            snapshot.injectedValues[key] = value;
            snapshot.injectedSources[key] = candidateSources[key] ?? 'app_config_json';
        }
    }

    envLoadSnapshots.set(targetEnv, snapshot);

    // 打印引导提示（非静默且非测试环境，且确实有关键配置注入时）
    if (shouldEmitConfigStartupLog(targetEnv, options.quiet) && Object.keys(injected).length > 0) {
        const injectedKeyNames = Object.keys(injected).filter((k) =>
            k.includes('KEY') || k.includes('TOKEN') || k.includes('PROXY')
        );
        if (injectedKeyNames.length > 0) {
            // 仅对测试/调试环境输出提示（不在 stdio 污染 stdout）
            console.error(`⚙️ [config] Auto-loaded config from ~/.my-websearch/config.json: ${injectedKeyNames.join(', ')}`);
        }
    }

    return injected;
}

