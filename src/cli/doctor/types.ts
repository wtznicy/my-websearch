import { ENGINE_REGISTRY } from '../../engines/registry.js';
import { ConfigValueSource } from '../../configLoader.js';

export const RECOGNIZED_ENV_KEYS = [
    'DEFAULT_SEARCH_ENGINE',
    'ALLOWED_SEARCH_ENGINES',
    'SEARCH_MODE',
    'PLAYWRIGHT_ENGINES',
    'PLAYWRIGHT_CDP_ENDPOINT',
    'PLAYWRIGHT_WS_ENDPOINT',
    'PLAYWRIGHT_EXECUTABLE_PATH',
    'PROXY_URL',
    'USE_PROXY',
    'PROXY_ENGINES',
    'SEARCH_DEADLINE_MS',
    'DEFAULT_SEARCH_LIMIT',
    'DEFAULT_MIN_RESULTS',
    'ENABLE_HTTP_SERVER',
    'ENABLE_CORS',
    'CORS_ORIGIN',
    'CONTEXT7_API_KEY',
    'EXA_API_KEY',
    'BRAVE_API_KEY',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'STACKOVERFLOW_API_KEY',
    'AUTO_ROUTE_EN_ENGINES',
    'AUTO_ROUTE_ZH_ENGINES',
    'BING_IMPERSONATE',
    'ANUBIS_MAX_POW_DIFFICULTY',
    'DIRECT_FIRST_PROBE_TIMEOUT_MS'
] as const;

export const ENGINE_NETWORK_PROBE_URLS: Record<string, string> = Object.fromEntries(
    ENGINE_REGISTRY.map((e) => [e.name, e.probeUrl])
);

export const DEFAULT_DOCTOR_PROBE_TTL_MS = 30_000;
export const DEFAULT_DOCTOR_PROBE_OK_TTL_MS = 30_000;
export const DEFAULT_DOCTOR_PROBE_CHALLENGE_TTL_MS = 10_000;
export const DEFAULT_DOCTOR_PROBE_FAILURE_TTL_MS = 5_000;

export type DoctorEngineProbeStage =
    | 'unchecked'
    | 'tcp_reachable'
    | 'http_reachable'
    | 'challenge'
    | 'parsed'
    | 'functional';

export type EngineNetworkProbeResult = {
    reachable: boolean;
    http?: 'reachable' | 'unreachable';
    application?: 'ok' | 'challenge' | 'parse_error' | 'unchecked';
    stage?: DoctorEngineProbeStage;
    latencyMs: number;
    probeDuration?: number;
    probeUserAgent?: string;
    error?: string;
    checkedAt?: string;
    cached?: boolean;
    ttlMs?: number;
    probeKind?: 'http_search' | 'config_only';
};

export type BrowserLaunchProbeResult = {
    available: boolean;
    status: 'configured' | 'reachable' | 'unreachable' | 'unavailable';
    mode: 'cdp' | 'executable' | 'default' | 'unavailable';
    probeKind?: 'config_only' | 'cdp_tcp' | 'browser_launch';
    target: string;
    headless: boolean;
    launched: boolean;
    pageOpened: boolean;
    isolatedProfile?: boolean;
    browserClosed?: boolean;
    latencyMs: number | null;
    error: string | null;
};

export type DoctorEngineStatus = {
    engine: string;
    allowed: boolean;
    usesProxy: boolean;
    circuitOpen: boolean;
    knownUnreachableOverseas: boolean;
    proxyTcp: 'direct' | 'reachable' | 'unreachable' | 'unchecked';
    http: 'reachable' | 'unreachable' | 'unchecked';
    application: 'ok' | 'challenge' | 'parse_error' | 'missing_api_key' | 'unchecked';
    stage: DoctorEngineProbeStage;
    networkStatus: 'unchecked' | 'reachable' | 'unreachable';
    status:
        | 'configured'
        | 'unchecked'
        | 'reachable'
        | 'unreachable'
        | 'blocked_by_antibot'
        | 'parse_error'
        | 'missing_api_key'
        | 'circuit_open'
        | 'proxy_unreachable'
        | 'disabled_by_whitelist';
    latencyMs?: number;
    probeDuration?: number;
    probeUserAgent?: string;
    checkedAt: string;
    cached: boolean;
    ttlMs: number;
    probeKind: 'http_search' | 'config_only';
    detail?: string;
};

export type DoctorReport = {
    version: string;
    checkedAt: string;
    networkChecked: boolean;
    browserChecked: boolean;
    networkNotice?: string;
    probeUserAgent?: string;
    cachePolicy?: {
        okTtlMs: number;
        challengeTtlMs: number;
        failureTtlMs: number;
    };
    probedEngines: string[];
    configSources: {
        appConfigFile: { path: string; exists: boolean };
        projectConfigFile: { path: string; exists: boolean };
        dotEnvFile: { path: string; exists: boolean };
        envOverrides: string[];
        keySources: Record<string, ConfigValueSource>;
    };
    effectiveConfig: {
        defaultSearchEngine: string;
        allowedSearchEngines: string[];
        searchMode: string;
        useProxy: boolean;
        proxyUrl: string;
        proxyEngines: string[];
        searchDeadlineMs: number;
        enableHttpServer: boolean;
        enableCors: boolean;
        corsOrigin: string;
        apiKeys: {
            context7: string | null;
            exa: string | null;
            brave: string | null;
            github: string | null;
            stackoverflow?: string | null;
        };
    };
    proxy: {
        enabled: boolean;
        server: string;
        status: 'disabled' | 'configured' | 'reachable' | 'unreachable';
        networkStatus: 'disabled' | 'unchecked' | 'reachable' | 'unreachable';
        tcpReachable: boolean | null;
        reachable: boolean | null;
        latencyMs: number | null;
        error: string | null;
        bypassRules: string[];
    };
    browser: BrowserLaunchProbeResult;
    engines: DoctorEngineStatus[];
    recommendations: string[];
    healthReset?: boolean;
};
