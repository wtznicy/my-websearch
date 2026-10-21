import { AppConfig, getProxyUrl } from '../../../config.js';
import { getProxyBypassRules } from '../../../utils/playwright/browserDiscovery.js';
import { DoctorEngineStatus, DoctorReport } from '../types.js';
import { probeTcpEndpoint } from './network.js';

export function maskProxyUrl(rawUrl: string | undefined | null): string {
    if (!rawUrl || !rawUrl.trim()) {
        return '';
    }
    const maskedAuth = rawUrl.trim().replace(
        /(\b(?:https?|wss?|socks5h?|socks4a?):\/\/)([^/@\s]+)@/gi,
        '$1***:***@'
    );
    return maskedAuth.replace(
        /([?&](?:token|key|api_key|apikey|secret|password|auth)=)([^&#\s]+)/gi,
        '$1***'
    );
}

export type ProxyTcpProbeResult = Awaited<ReturnType<typeof probeTcpEndpoint>>;

export async function probeProxyTcp(
    proxyUrl: string | undefined,
    timeoutMs = 1000
): Promise<ProxyTcpProbeResult> {
    if (!proxyUrl || !proxyUrl.trim()) {
        return null;
    }
    return probeTcpEndpoint(proxyUrl, timeoutMs);
}

export async function evaluateProxyDoctor(
    appConfig: AppConfig,
    options: {
        proxyProbeTimeoutMs: number;
        networkChecked: boolean;
        engines: DoctorEngineStatus[];
        proxyTcpProbe?: ProxyTcpProbeResult;
        probeUpstreamFallback?: () => Promise<{ reachable: boolean; http?: 'reachable' | 'unreachable'; error?: string }>;
    }
): Promise<{
    proxy: DoctorReport['proxy'];
    effectiveProxyServer?: string;
    proxyTcpProbe: ProxyTcpProbeResult;
}> {
    const effectiveProxyServer = getProxyUrl(appConfig);
    const proxyTcpProbe = options.proxyTcpProbe !== undefined
        ? options.proxyTcpProbe
        : (appConfig.useProxy && effectiveProxyServer
            ? await probeTcpEndpoint(effectiveProxyServer, options.proxyProbeTimeoutMs)
            : null);

    let proxyStatus: DoctorReport['proxy']['status'] = 'disabled';
    let proxyNetworkStatus: DoctorReport['proxy']['networkStatus'] = 'disabled';
    let proxyError: string | null = proxyTcpProbe?.error ?? null;

    if (appConfig.useProxy && effectiveProxyServer) {
        if (!proxyTcpProbe || !proxyTcpProbe.reachable) {
            proxyStatus = 'unreachable';
            proxyNetworkStatus = 'unreachable';
        } else if (options.networkChecked) {
            const probedProxiedEngines = options.engines.filter(
                (e) => e.usesProxy && e.http !== 'unchecked'
            );
            if (probedProxiedEngines.length > 0) {
                const anyHttpReachable = probedProxiedEngines.some((e) => e.http === 'reachable');
                proxyStatus = anyHttpReachable ? 'reachable' : 'unreachable';
                proxyNetworkStatus = anyHttpReachable ? 'reachable' : 'unreachable';
                if (!anyHttpReachable) {
                    proxyError = probedProxiedEngines[0]?.detail ?? 'Upstream target unreachable via proxy';
                }
            } else if (options.probeUpstreamFallback) {
                const upstreamProbe = await options.probeUpstreamFallback();
                const upstreamHttpReachable = (upstreamProbe.http ?? (upstreamProbe.reachable ? 'reachable' : 'unreachable')) === 'reachable';
                proxyStatus = upstreamHttpReachable ? 'reachable' : 'unreachable';
                proxyNetworkStatus = upstreamHttpReachable ? 'reachable' : 'unreachable';
                if (!upstreamHttpReachable && upstreamProbe.error) {
                    proxyError = upstreamProbe.error;
                }
            }
        } else {
            proxyStatus = 'configured';
            proxyNetworkStatus = 'unchecked';
        }
    }

    const proxy: DoctorReport['proxy'] = {
        enabled: appConfig.useProxy,
        // 代理未启用时不要回显那个不生效的默认 URL（config 里的 DEFAULT_PROXY_URL）。
        // 它曾把排查方向带偏：「doctor 显示 7897，是不是工具还在走代理？」
        server: appConfig.useProxy ? maskProxyUrl(effectiveProxyServer) : '',
        status: proxyStatus,
        networkStatus: proxyNetworkStatus,
        tcpReachable: proxyTcpProbe ? proxyTcpProbe.reachable : null,
        reachable: proxyStatus === 'disabled'
            ? null
            : proxyStatus === 'unreachable'
                ? false
                : true,
        latencyMs: proxyTcpProbe ? proxyTcpProbe.latencyMs : null,
        error: proxyError,
        bypassRules: appConfig.useProxy ? getProxyBypassRules(appConfig) : []
    };

    return {
        proxy,
        effectiveProxyServer,
        proxyTcpProbe
    };
}
