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
        proxyUrl: maskProxyUrl(appConfig.proxyUrl),
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
        `  API keys:        context7=${report.effectiveConfig.apiKeys.context7 ?? 'unset'}, exa=${report.effectiveConfig.apiKeys.exa ?? 'unset'}, brave=${report.effectiveConfig.apiKeys.brave ?? 'unset'}, github=${report.effectiveConfig.apiKeys.github ?? 'unset'}, stackoverflow=${report.effectiveConfig.apiKeys.stackoverflow ?? 'unset'}`,
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
        const cacheInfo = eng.probeKind === 'http_search'
            ? ` probe=${eng.probeKind} cached=${eng.cached ? 'yes' : 'no'} ttl=${eng.ttlMs}ms`
            : ` probe=${eng.probeKind}`;
        lines.push(
            `  - ${eng.engine.padEnd(11)} status=${eng.status.padEnd(21)} stage=${eng.stage.padEnd(14)} proxyTcp=${eng.proxyTcp.padEnd(11)} http=${eng.http.padEnd(11)} app=${eng.application.padEnd(15)} route=${eng.usesProxy ? 'proxy' : 'direct'}${cacheInfo}${extra}`
        );
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
