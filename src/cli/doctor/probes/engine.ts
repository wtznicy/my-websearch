import axios from 'axios';
import { AppConfig, engineShouldUseProxy } from '../../../config.js';
import {
    isBaiduAntiBotPage,
    isBingAntiBotPage,
    isBraveBlockedPage,
    isSogouChallengePage,
    isStartpageCaptchaPage,
    looksLikeBotChallengePage
} from '../../../core/antiBot/antiBotDetection.js';
import { ENGINE_REGISTRY } from '../../../engines/registry.js';
import { BROWSER_USER_AGENT } from '../../../utils/constants.js';
import { buildAxiosRequestOptions } from '../../../utils/httpRequest.js';
import { isEngineCircuitOpen } from '../../../core/search/engineCircuitBreaker.js';
import { normalizeEngineName, SUPPORTED_SEARCH_ENGINES } from '../../../core/search/searchEngines.js';
import { isKnownUnreachableOverseasEngine } from '../../../utils/overseasProbe.js';
import {
    DoctorEngineProbeStage,
    DoctorEngineStatus,
    EngineNetworkProbeResult
} from '../types.js';

const ENGINE_NETWORK_PROBE_URLS: Record<string, string> = Object.fromEntries(
    ENGINE_REGISTRY.map((e) => [e.name, e.probeUrl])
);

type CachedProbeEntry = {
    expiresAt: number;
    ttlMs: number;
    result: EngineNetworkProbeResult;
};

const doctorProbeCache = new Map<string, CachedProbeEntry>();

export function clearDoctorProbeCache(): void {
    doctorProbeCache.clear();
}

export function isEngineProbeChallengeResponse(
    engine: string,
    status: number,
    body: string
): boolean {
    if (status === 403 || status === 429) {
        return true;
    }
    if (engine === 'duckduckgo' && status === 202) {
        return true;
    }
    if (!body || typeof body !== 'string') {
        return false;
    }
    if (engine === 'baidu' && isBaiduAntiBotPage(body)) {
        return true;
    }
    if (engine === 'bing' && isBingAntiBotPage(body)) {
        return true;
    }
    if (engine === 'sogou' && isSogouChallengePage(body)) {
        return true;
    }
    if (engine === 'brave' && isBraveBlockedPage(body)) {
        return true;
    }
    if (engine === 'startpage' && (isStartpageCaptchaPage(body) || /anubis|\/sp\/captcha/i.test(body))) {
        return true;
    }
    if (engine === 'duckduckgo' && /anomaly-modal|challenge-form|cc=botnet/i.test(body)) {
        return true;
    }
    return looksLikeBotChallengePage(body, { status });
}

export function verifyEngineProbeResponseStructure(
    engine: string,
    status: number,
    body: string
): { stage: 'http_reachable' | 'parsed' | 'functional'; application: 'ok' | 'parse_error' } {
    if (status < 200 || status >= 400) {
        return { stage: 'http_reachable', application: 'parse_error' };
    }
    if (engine === 'juejin' || engine === 'exa') {
        return { stage: 'functional', application: 'ok' };
    }
    if (!body || !body.trim()) {
        return { stage: 'http_reachable', application: 'parse_error' };
    }
    if (engine === 'csdn') {
        try {
            const parsed = JSON.parse(body) as { result_vos?: unknown[] };
            if (Array.isArray(parsed.result_vos)) {
                return {
                    stage: parsed.result_vos.length > 0 ? 'functional' : 'parsed',
                    application: 'ok'
                };
            }
        } catch {
            // fall through
        }
        return { stage: 'http_reachable', application: 'parse_error' };
    }
    const lower = body.toLowerCase();
    const hasExpectedResults: Record<string, boolean> = {
        bing: lower.includes('b_results') || lower.includes('b_algo'),
        baidu: lower.includes('content_left') || lower.includes('c-container') || lower.includes('result'),
        sogou: lower.includes('results') || lower.includes('vrresult') || lower.includes('resitem'),
        duckduckgo: lower.includes('result__a') || lower.includes('links.duckduckgo.com/d.js') || lower.includes('results'),
        brave: lower.includes('snippet') || lower.includes('results') || lower.includes('fdb'),
        startpage: lower.includes('w-gl') || lower.includes('result') || lower.includes('search-result')
    };
    if (hasExpectedResults[engine] ?? true) {
        return { stage: 'functional', application: 'ok' };
    }
    return { stage: 'http_reachable', application: 'parse_error' };
}

export async function probeEngineHttpEndpoint(
    engine: string,
    _appConfig: AppConfig,
    timeoutMs: number
): Promise<EngineNetworkProbeResult> {
    const url = ENGINE_NETWORK_PROBE_URLS[engine] ?? 'https://www.bing.com/search?q=mcp&count=1';
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const probeUserAgent = BROWSER_USER_AGENT;
    try {
        const response = await axios.get(
            url,
            buildAxiosRequestOptions({
                engine,
                trustedStaticHost: true,
                timeout: timeoutMs,
                maxRedirects: 3,
                responseType: 'text',
                headers: {
                    'User-Agent': probeUserAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                },
                validateStatus: (status) => status >= 200 && status < 500
            })
        );
        const body = typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data ?? '');
        const latencyMs = Date.now() - startedAt;
        if (isEngineProbeChallengeResponse(engine, response.status, body)) {
            return {
                reachable: false,
                http: 'reachable',
                application: 'challenge',
                stage: 'challenge',
                latencyMs,
                probeDuration: latencyMs,
                probeUserAgent,
                checkedAt,
                error: `Upstream anti-bot challenge detected (HTTP ${response.status})`
            };
        }
        const verified = verifyEngineProbeResponseStructure(engine, response.status, body);
        if (verified.application === 'parse_error') {
            return {
                reachable: false,
                http: 'reachable',
                application: 'parse_error',
                stage: 'http_reachable',
                latencyMs,
                probeDuration: latencyMs,
                probeUserAgent,
                checkedAt,
                error: `HTTP ${response.status} received but expected search result structure was not found`
            };
        }
        return {
            reachable: true,
            http: 'reachable',
            application: 'ok',
            stage: verified.stage,
            latencyMs,
            probeDuration: latencyMs,
            probeUserAgent,
            checkedAt
        };
    } catch (error) {
        const latencyMs = Date.now() - startedAt;
        return {
            reachable: false,
            http: 'unreachable',
            application: 'unchecked',
            stage: 'unchecked',
            latencyMs,
            probeDuration: latencyMs,
            probeUserAgent,
            checkedAt,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export type CachedEngineProbeOptions = {
    rawProbeNetwork: (
        engine: string,
        appConfig: AppConfig,
        timeoutMs: number
    ) => Promise<EngineNetworkProbeResult>;
    okCacheTtlMs: number;
    challengeCacheTtlMs: number;
    failureCacheTtlMs: number;
    effectiveProxyServer?: string;
};

export async function probeNetworkWithCache(
    engine: string,
    appConfig: AppConfig,
    timeoutMs: number,
    options: CachedEngineProbeOptions
): Promise<EngineNetworkProbeResult> {
    const usesProxy = engineShouldUseProxy(engine, appConfig);
    const cacheKey = `${engine}|${usesProxy ? options.effectiveProxyServer : 'direct'}`;
    const now = Date.now();
    if (options.okCacheTtlMs > 0 || options.challengeCacheTtlMs > 0 || options.failureCacheTtlMs > 0) {
        const cached = doctorProbeCache.get(cacheKey);
        if (cached && cached.expiresAt > now) {
            return {
                ...cached.result,
                cached: true,
                ttlMs: cached.ttlMs,
                probeKind: cached.result.probeKind ?? 'http_search'
            };
        }
    }
    const raw = await options.rawProbeNetwork(engine, appConfig, timeoutMs);
    const effectiveTtlMs = raw.application === 'challenge'
        ? options.challengeCacheTtlMs
        : (!raw.reachable || raw.application === 'parse_error')
            ? options.failureCacheTtlMs
            : options.okCacheTtlMs;
    const normalized: EngineNetworkProbeResult = {
        ...raw,
        probeDuration: raw.probeDuration ?? raw.latencyMs,
        probeUserAgent: raw.probeUserAgent ?? BROWSER_USER_AGENT,
        checkedAt: raw.checkedAt ?? new Date().toISOString(),
        cached: false,
        ttlMs: raw.ttlMs ?? effectiveTtlMs,
        probeKind: raw.probeKind ?? 'http_search'
    };
    if (effectiveTtlMs > 0) {
        doctorProbeCache.set(cacheKey, {
            expiresAt: now + effectiveTtlMs,
            ttlMs: effectiveTtlMs,
            result: normalized
        });
    }
    return normalized;
}

export async function evaluateEnginesDoctor(
    appConfig: AppConfig,
    options: {
        explicitEngines?: string[];
        networkChecked: boolean;
        networkProbeTimeoutMs: number;
        rawProbeNetwork: (engine: string, appConfig: AppConfig, timeoutMs: number) => Promise<EngineNetworkProbeResult>;
        okCacheTtlMs: number;
        challengeCacheTtlMs: number;
        failureCacheTtlMs: number;
        effectiveProxyServer?: string;
        proxyProbe: { reachable: boolean } | null;
        hasExaApiKey: boolean;
        checkedAt: string;
    }
): Promise<{
    engines: DoctorEngineStatus[];
    probedEngines: string[];
}> {
    const allowedList = appConfig.allowedSearchEngines;
    const explicitTargets = (options.explicitEngines ?? [])
        .map((e) => normalizeEngineName(e))
        .filter((e): e is typeof SUPPORTED_SEARCH_ENGINES[number] => Boolean(e));

    const defaultRequiredEngines = allowedList.length > 0
        ? allowedList
        : Array.from(new Set([
            ...(appConfig.defaultSearchEngine && appConfig.defaultSearchEngine !== 'auto'
                ? [appConfig.defaultSearchEngine]
                : []),
            'bing',
            'baidu'
        ]));

    const targetEnginesSet = new Set<string>(
        explicitTargets.length > 0 ? explicitTargets : defaultRequiredEngines
    );
    const probedEngines: string[] = [];

    const probeOptions: CachedEngineProbeOptions = {
        rawProbeNetwork: options.rawProbeNetwork,
        okCacheTtlMs: options.okCacheTtlMs,
        challengeCacheTtlMs: options.challengeCacheTtlMs,
        failureCacheTtlMs: options.failureCacheTtlMs,
        effectiveProxyServer: options.effectiveProxyServer
    };

    const engines: DoctorEngineStatus[] = await Promise.all(
        SUPPORTED_SEARCH_ENGINES.map(async (engine): Promise<DoctorEngineStatus> => {
            const allowed = allowedList.length === 0 || allowedList.includes(engine);
            const usesProxy = engineShouldUseProxy(engine, appConfig);
            const circuitOpen = isEngineCircuitOpen(engine);
            const knownUnreachableOverseas = isKnownUnreachableOverseasEngine(engine);
            const proxyTcp: DoctorEngineStatus['proxyTcp'] = !usesProxy
                ? 'direct'
                : options.proxyProbe
                    ? (options.proxyProbe.reachable ? 'reachable' : 'unreachable')
                    : 'unchecked';

            if (!allowed && explicitTargets.length === 0) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp,
                    http: 'unchecked',
                    application: 'unchecked',
                    stage: 'unchecked',
                    networkStatus: 'unchecked',
                    status: 'disabled_by_whitelist',
                    checkedAt: options.checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only'
                };
            }

            if (engine === 'exa' && !options.hasExaApiKey) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp,
                    http: 'unchecked',
                    application: 'missing_api_key',
                    stage: 'unchecked',
                    networkStatus: 'unchecked',
                    status: 'missing_api_key',
                    checkedAt: options.checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only',
                    detail: 'EXA_API_KEY is not configured'
                };
            }

            if (circuitOpen) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp,
                    http: 'unchecked',
                    application: 'unchecked',
                    stage: 'unchecked',
                    networkStatus: 'unreachable',
                    status: 'circuit_open',
                    checkedAt: options.checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only'
                };
            }

            if (usesProxy && options.proxyProbe && !options.proxyProbe.reachable) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp: 'unreachable',
                    http: 'unchecked',
                    application: 'unchecked',
                    stage: 'unchecked',
                    networkStatus: 'unreachable',
                    status: 'proxy_unreachable',
                    checkedAt: options.checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only'
                };
            }

            if (knownUnreachableOverseas && !usesProxy) {
                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp: 'direct',
                    http: 'unreachable',
                    application: 'unchecked',
                    stage: 'unchecked',
                    networkStatus: 'unreachable',
                    status: 'unreachable',
                    checkedAt: options.checkedAt,
                    cached: false,
                    ttlMs: 0,
                    probeKind: 'config_only',
                    detail: 'Direct overseas connection previously timed out; proxy recommended'
                };
            }

            if (options.networkChecked && targetEnginesSet.has(engine)) {
                probedEngines.push(engine);
                const netProbe = await probeNetworkWithCache(engine, appConfig, options.networkProbeTimeoutMs, probeOptions);
                const httpStatus: DoctorEngineStatus['http'] = netProbe.http ?? (netProbe.reachable ? 'reachable' : 'unreachable');
                const appStatus: DoctorEngineStatus['application'] = netProbe.application ?? (netProbe.reachable ? 'ok' : 'unchecked');
                const stage: DoctorEngineProbeStage = netProbe.stage ?? (
                    appStatus === 'challenge'
                        ? 'challenge'
                        : appStatus === 'parse_error'
                            ? 'http_reachable'
                            : netProbe.reachable
                                ? 'functional'
                                : httpStatus === 'reachable'
                                    ? 'http_reachable'
                                    : proxyTcp === 'reachable'
                                        ? 'tcp_reachable'
                                        : 'unchecked'
                );
                const finalStatus: DoctorEngineStatus['status'] = appStatus === 'challenge'
                    ? 'blocked_by_antibot'
                    : appStatus === 'parse_error'
                        ? 'parse_error'
                        : netProbe.reachable
                            ? 'reachable'
                            : 'unreachable';

                return {
                    engine,
                    allowed,
                    usesProxy,
                    circuitOpen,
                    knownUnreachableOverseas,
                    proxyTcp,
                    http: httpStatus,
                    application: appStatus,
                    stage,
                    networkStatus: (httpStatus === 'reachable' || netProbe.reachable) ? 'reachable' : 'unreachable',
                    status: finalStatus,
                    latencyMs: netProbe.latencyMs,
                    probeDuration: netProbe.probeDuration ?? netProbe.latencyMs,
                    probeUserAgent: netProbe.probeUserAgent ?? BROWSER_USER_AGENT,
                    checkedAt: netProbe.checkedAt ?? options.checkedAt,
                    cached: Boolean(netProbe.cached),
                    ttlMs: netProbe.ttlMs ?? options.okCacheTtlMs,
                    probeKind: netProbe.probeKind ?? 'http_search',
                    ...(netProbe.error ? { detail: netProbe.error } : {})
                };
            }

            return {
                engine,
                allowed,
                usesProxy,
                circuitOpen,
                knownUnreachableOverseas,
                proxyTcp,
                http: 'unchecked',
                application: 'unchecked',
                stage: proxyTcp === 'reachable' ? 'tcp_reachable' : 'unchecked',
                networkStatus: 'unchecked',
                status: !allowed ? 'disabled_by_whitelist' : 'configured',
                checkedAt: options.checkedAt,
                cached: false,
                ttlMs: 0,
                probeKind: 'config_only'
            };
        })
    );

    return {
        engines,
        probedEngines
    };
}

