import fs from 'node:fs';
import path from 'node:path';
import { AppConfig } from '../../config.js';
import {
    ConfigValueSource,
    getAppConfigFilePath,
    getConfigLoadSnapshot,
    sanitizePathForLog
} from '../../configLoader.js';
import { maskProxyUrl } from './probes/proxy.js';
import {
    DoctorEngineStatus,
    DoctorReport,
    RECOGNIZED_ENV_KEYS
} from './types.js';

export function maskSecret(value: string | undefined | null): string | null {
    if (!value || !value.trim()) {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length <= 6) {
        return '***';
    }
    return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

export function collectDoctorConfigSources(
    env: NodeJS.ProcessEnv,
    cwd: string
): {
    configSources: DoctorReport['configSources'];
    envOverrides: string[];
} {
    const appConfigPath = getAppConfigFilePath(env);
    const projectConfigPath = path.resolve(cwd, '.my-websearch.json');
    const dotEnvPath = path.resolve(cwd, '.env');

    const snapshot = getConfigLoadSnapshot(env);
    const keySources: Record<string, ConfigValueSource> = {};
    const envOverrides: string[] = [];

    for (const key of RECOGNIZED_ENV_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(env, key) || env[key] === undefined) {
            continue;
        }
        const currentValue = String(env[key]);
        if (
            snapshot
            && Object.prototype.hasOwnProperty.call(snapshot.injectedSources, key)
            && snapshot.injectedValues[key] === currentValue
        ) {
            keySources[key] = snapshot.injectedSources[key]!;
        } else if (currentValue.trim().length > 0 || snapshot?.initialEnvKeys.has(key)) {
            keySources[key] = 'process_env';
            envOverrides.push(key);
        }
    }

    return {
        configSources: {
            appConfigFile: {
                path: sanitizePathForLog(appConfigPath),
                exists: fs.existsSync(appConfigPath)
            },
            projectConfigFile: {
                path: sanitizePathForLog(projectConfigPath),
                exists: fs.existsSync(projectConfigPath)
            },
            dotEnvFile: {
                path: sanitizePathForLog(dotEnvPath),
                exists: fs.existsSync(dotEnvPath)
            },
            envOverrides,
            keySources
        },
        envOverrides
    };
}

export function buildDoctorEffectiveConfig(
    appConfig: AppConfig,
    env: NodeJS.ProcessEnv
): DoctorReport['effectiveConfig'] {
    return {
        defaultSearchEngine: appConfig.defaultSearchEngine,
        allowedSearchEngines: appConfig.allowedSearchEngines,
        searchMode: appConfig.searchMode,
        useProxy: appConfig.useProxy,
        proxyUrl: appConfig.useProxy ? maskProxyUrl(appConfig.proxyUrl) : null,
        proxyEngines: appConfig.proxyEngines,
        searchDeadlineMs: appConfig.searchDeadlineMs,
        enableHttpServer: appConfig.enableHttpServer,
        enableCors: Boolean(appConfig.enableCors),
        corsOrigin: appConfig.corsOrigin ?? '*',
        apiKeys: {
            context7: maskSecret(env.CONTEXT7_API_KEY),
            exa: maskSecret(env.EXA_API_KEY),
            brave: maskSecret(env.BRAVE_API_KEY),
            github: maskSecret(env.GITHUB_TOKEN || env.GH_TOKEN),
            gitee: maskSecret(env.GITEE_TOKEN),
            stackoverflow: maskSecret(env.STACKOVERFLOW_API_KEY)
        }
    };
}

export function generateDoctorRecommendations(options: {
    useProxy: boolean;
    effectiveProxyServer?: string;
    proxyProbe: { reachable: boolean; error?: string } | null;
    proxyStatus: DoctorReport['proxy']['status'];
    networkChecked: boolean;
    proxyError: string | null;
    engines: DoctorEngineStatus[];
    browserInfo: DoctorReport['browser'];
    browserChecked: boolean;
    defaultSearchEngine: string;
    allowedList: string[];
    hasExaApiKey: boolean;
    env: NodeJS.ProcessEnv;
}): string[] {
    const recommendations: string[] = [];
    if (options.useProxy && options.proxyProbe && !options.proxyProbe.reachable) {
        recommendations.push(
            `Configured proxy (${maskProxyUrl(options.effectiveProxyServer)}) is not reachable on local TCP port (${options.proxyProbe.error ?? 'connection failed'}). Start your local proxy or set PROXY_URL=direct for domestic-only mode.`
        );
    } else if (options.useProxy && options.proxyStatus === 'unreachable' && options.networkChecked) {
        recommendations.push(
            `Configured proxy (${maskProxyUrl(options.effectiveProxyServer)}) accepted local TCP connection, but upstream requests failed (${options.proxyError ?? 'upstream unreachable'}). Check proxy credentials/protocol or upstream node.`
        );
    }
    const antibotBlockedEngines = options.engines.filter((e) => e.status === 'blocked_by_antibot').map((e) => e.engine);
    if (antibotBlockedEngines.length > 0) {
        recommendations.push(
            `Upstream anti-bot challenge detected on ${antibotBlockedEngines.join(', ')} (TCP/HTTP connected, application layer challenged). Consider switching proxy node or using browser/alternative engines.`
        );
    }
    if (!options.browserInfo.available) {
        if (options.browserInfo.mode === 'cdp') {
            recommendations.push(
                `Configured Playwright CDP endpoint (${options.browserInfo.target}) is not reachable (${options.browserInfo.error ?? 'connection failed'}). Start the remote browser or unset PLAYWRIGHT_CDP_ENDPOINT to use a local browser.`
            );
        } else if (options.browserInfo.mode === 'executable' && options.browserChecked) {
            recommendations.push(
                `Browser executable (${options.browserInfo.target}) failed to launch or open a test page (${options.browserInfo.error ?? 'launch failed'}). Verify browser installation, permissions, or proxy parameters.`
            );
        } else {
            recommendations.push(
                'No local Chromium/Edge/Chrome browser was detected. Install Edge/Chrome or set PLAYWRIGHT_EXECUTABLE_PATH for browser-rendered search and anti-bot fallback.'
            );
        }
    }
    if (!options.hasExaApiKey && (options.defaultSearchEngine === 'exa' || options.allowedList.includes('exa'))) {
        recommendations.push(
            'EXA_API_KEY is not configured; the exa engine cannot be used until EXA_API_KEY is set.'
        );
    }
    if (!options.env.CONTEXT7_API_KEY?.trim()) {
        recommendations.push(
            'CONTEXT7_API_KEY is not configured; resolveLibraryId/queryDocs will run on anonymous public quota.'
        );
    }
    return recommendations;
}

export function formatDoctorHumanReadable(report: DoctorReport): string {
    const proxyDesc = !report.proxy.enabled
        ? 'disabled'
        : report.proxy.status === 'configured'
            ? `local TCP open (${report.proxy.latencyMs}ms), upstream unchecked (use --network to probe)`
            : report.proxy.status === 'reachable'
                ? `reachable (${report.proxy.latencyMs}ms)`
                : `unreachable (${report.proxy.error ?? 'failed'})`;

    const browserProbeKind = report.browser.probeKind ?? (report.browserChecked ? 'browser_launch' : 'config_only');
    const browserLaunchDesc = report.browserChecked
        ? `, probeKind=${browserProbeKind}, launched=${report.browser.launched ? 'yes' : 'no'}, pageOpened=${report.browser.pageOpened ? 'yes' : 'no'}${report.browser.latencyMs !== null ? ` (${report.browser.latencyMs}ms)` : ''}`
        : ` (probeKind=${browserProbeKind}; path check only; use --browser to verify launch)`;

    // 每个 key 的来源：env / config / project / .env（便于排查「env 覆盖了 config」或「空值堵死注入」）
    const keySourceLabel = (envKey: string): string => {
        switch (report.configSources.keySources[envKey]) {
            case 'process_env':
                return 'env';
            case 'app_config_json':
                return 'config';
            case 'project_config_json':
                return 'project';
            case 'dot_env':
                return '.env';
            default:
                return 'unset';
        }
    };
    const apiKeyPairs: Array<[keyof typeof report.effectiveConfig.apiKeys, string]> = [
        ['context7', 'CONTEXT7_API_KEY'],
        ['exa', 'EXA_API_KEY'],
        ['brave', 'BRAVE_API_KEY'],
        ['github', 'GITHUB_TOKEN'],
        ['gitee', 'GITEE_TOKEN'],
        ['stackoverflow', 'STACKOVERFLOW_API_KEY']
    ];
    const apiKeyLine = apiKeyPairs
        .map(([name, envKey]) => {
            const value = report.effectiveConfig.apiKeys[name];
            return value ? `${name}=${value} (${keySourceLabel(envKey)})` : `${name}=unset`;
        })
        .join(', ');

    const lines = [
        `my-websearch doctor (v${report.version})`,
        `Checked at: ${report.checkedAt}`,
        ...(report.healthReset ? ['Health state reset: yes'] : []),
        ...(report.networkNotice ? [`Notice: ${report.networkNotice}`] : []),
        '',
        'Configuration sources:',
        `  App config:     ${report.configSources.appConfigFile.path} (${report.configSources.appConfigFile.exists ? 'found' : 'missing'})`,
        `  Project config: ${report.configSources.projectConfigFile.path} (${report.configSources.projectConfigFile.exists ? 'found' : 'missing'})`,
        `  .env file:      ${report.configSources.dotEnvFile.path} (${report.configSources.dotEnvFile.exists ? 'found' : 'missing'})`,
        `  Process env:    ${report.configSources.envOverrides.length > 0 ? report.configSources.envOverrides.join(', ') : '(none)'}`,
        '',
        'Effective configuration:',
        `  Default engine:  ${report.effectiveConfig.defaultSearchEngine}`,
        `  Allowed engines: ${report.effectiveConfig.allowedSearchEngines.length > 0 ? report.effectiveConfig.allowedSearchEngines.join(', ') : '(all)'}`,
        `  Search mode:     ${report.effectiveConfig.searchMode}`,
        `  Search deadline: ${report.effectiveConfig.searchDeadlineMs}ms`,
        `  HTTP CORS:       ${report.effectiveConfig.enableCors ? `enabled (${report.effectiveConfig.corsOrigin})` : 'disabled'}`,
        `  API keys:        ${apiKeyLine}`,
        ...(report.effectiveConfig.apiKeys.github
            ? []
            : ['  ⚠️ codeSymbol needs GITHUB_TOKEN: add "github" under apiKeys in ~/.my-websearch/config.json and restart the MCP server.']
        ),
        '',
        'Proxy:',
        `  Enabled:         ${report.proxy.enabled ? 'yes' : 'no'}`,
        `  Server:          ${report.proxy.server || '(none)'}`,
        `  Status:          ${proxyDesc}`,
        `  Proxy engines:   ${report.effectiveConfig.proxyEngines.length > 0 ? report.effectiveConfig.proxyEngines.join(', ') : report.proxy.enabled ? '(all)' : '(none)'}`,
        '',
        'Browser:',
        `  Available:       ${report.browser.available ? 'yes' : 'no'} (${report.browser.status}${browserLaunchDesc})`,
        `  Mode:            ${report.browser.mode}`,
        `  Target:          ${report.browser.target || '(none)'}`,
        ...(report.browser.error ? [`  Error:           ${report.browser.error}`] : []),
        '',
        `Engines (network=${report.networkChecked ? `checked [${report.probedEngines.join(', ') || 'none'}]` : 'unchecked'}):`
    ];

    for (const eng of report.engines) {
        const extra = eng.detail ? ` (${eng.detail})` : '';
        const challengeInfo = eng.challengeKind ? ` challenge=${eng.challengeKind}` : '';
        const circuitInfo = eng.circuitRemainingMs && eng.circuitRemainingMs > 0
            ? ` circuit=${Math.ceil(eng.circuitRemainingMs / 1000)}s`
            : '';
        const latencyInfo = eng.p50Ms !== undefined && eng.p95Ms !== undefined
            ? ` p50=${eng.p50Ms}ms p95=${eng.p95Ms}ms`
            : '';
        const cacheInfo = eng.probeKind === 'http_search'
            ? ` probe=${eng.probeKind} cached=${eng.cached ? 'yes' : 'no'} ttl=${eng.ttlMs}ms`
            : ` probe=${eng.probeKind}`;
        lines.push(
            `  - ${eng.engine.padEnd(11)} status=${eng.status.padEnd(21)} stage=${eng.stage.padEnd(14)} proxyTcp=${eng.proxyTcp.padEnd(11)} http=${eng.http.padEnd(11)} app=${eng.application.padEnd(15)} route=${eng.usesProxy ? 'proxy' : 'direct'}${cacheInfo}${challengeInfo}${circuitInfo}${latencyInfo}${extra}`
        );
    }

    if (report.cacheStats) {
        lines.push('');
        lines.push('Cache hit rate:');
        lines.push(`  Search cache:    ${report.cacheStats.search.hitRate}% (${report.cacheStats.search.hits} hits, ${report.cacheStats.search.misses} misses)`);
        lines.push(`  Fetch pageCache: ${report.cacheStats.fetch.hitRate}% (${report.cacheStats.fetch.hits} hits, ${report.cacheStats.fetch.misses} misses)`);
    }

    if (report.engineLatency.length > 0) {
        lines.push('');
        lines.push('Engine latency (last 7 days, persisted across runs):');
        for (const item of report.engineLatency) {
            lines.push(
                `  - ${item.engine.padEnd(13)} p50=${String(item.p50).padStart(6)}ms  p95=${String(item.p95).padStart(6)}ms  success=${String(item.successRate).padStart(3)}%  n=${item.samples}`
            );
        }
    }

    if (report.recommendations.length > 0) {
        lines.push('');
        lines.push('Recommendations:');
        for (const rec of report.recommendations) {
            lines.push(`  * ${rec}`);
        }
    }

    return lines.join('\n');
}
