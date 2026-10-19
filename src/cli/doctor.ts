import { AppConfig, getProxyUrl } from '../config.js';
import { resetEngineCircuits } from '../core/search/engineCircuitBreaker.js';
import { metrics } from '../core/metrics.js';
import { ENGINE_REGISTRY } from '../engines/registry.js';
import { MyWebSearchRuntime } from '../runtime/runtimeTypes.js';
import { BROWSER_USER_AGENT } from '../utils/constants.js';
import { __resetDirectSlowHostCacheForTests } from '../utils/httpRequest.js';
import { __setOverseasReachableForTests } from '../utils/overseasProbe.js';
import { resetDnsCache } from '../utils/dnsCache.js';
import { resetSystemProxyCache } from '../utils/systemProxy.js';
import { __resetGithubReadmeCacheForTests } from '../engines/github/github.js';
import { resetContext7Cache } from '../core/context7/context7Service.js';

// Types & Constants
import {
    DEFAULT_DOCTOR_PROBE_TTL_MS,
    DEFAULT_DOCTOR_PROBE_OK_TTL_MS,
    DEFAULT_DOCTOR_PROBE_CHALLENGE_TTL_MS,
    DEFAULT_DOCTOR_PROBE_FAILURE_TTL_MS,
    DoctorEngineProbeStage,
    EngineNetworkProbeResult,
    BrowserLaunchProbeResult,
    DoctorEngineStatus,
    DoctorReport
} from './doctor/types.js';

// Probes
import { probeTcpEndpoint } from './doctor/probes/network.js';
import { maskProxyUrl, probeProxyTcp, evaluateProxyDoctor } from './doctor/probes/proxy.js';
import { sanitizeBrowserTargetForDoctor, probeBrowserLaunch, evaluateBrowserDoctor } from './doctor/probes/browser.js';
import {
    clearDoctorProbeCache,
    isEngineProbeChallengeResponse,
    verifyEngineProbeResponseStructure,
    probeEngineHttpEndpoint,
    probeNetworkWithCache,
    evaluateEnginesDoctor,
    CachedEngineProbeOptions
} from './doctor/probes/engine.js';

// Report format & masking
import {
    maskSecret,
    formatDoctorHumanReadable,
    collectDoctorConfigSources,
    buildDoctorEffectiveConfig,
    generateDoctorRecommendations
} from './doctor/report.js';

// Re-exports for backward compatibility
export {
    DEFAULT_DOCTOR_PROBE_TTL_MS,
    DEFAULT_DOCTOR_PROBE_OK_TTL_MS,
    DEFAULT_DOCTOR_PROBE_CHALLENGE_TTL_MS,
    DEFAULT_DOCTOR_PROBE_FAILURE_TTL_MS,
    probeTcpEndpoint,
    maskProxyUrl,
    probeProxyTcp,
    sanitizeBrowserTargetForDoctor,
    probeBrowserLaunch,
    clearDoctorProbeCache,
    isEngineProbeChallengeResponse,
    verifyEngineProbeResponseStructure,
    probeEngineHttpEndpoint,
    maskSecret,
    formatDoctorHumanReadable
};

export type {
    DoctorEngineProbeStage,
    EngineNetworkProbeResult,
    BrowserLaunchProbeResult,
    DoctorEngineStatus,
    DoctorReport
};

/**
 * 重置所有进程内熔断状态、运行时指标、指纹失败计数、直连慢主机缓存、海外探测缓存与搜索缓存。
 * 供 doctor --reset-health 或单元测试调用，防止长时间运行或网络波动污染诊断结果。
 */
export function resetAllHealthState(runtime?: MyWebSearchRuntime): void {
    resetEngineCircuits();
    metrics.reset();
    __resetDirectSlowHostCacheForTests();
    __setOverseasReachableForTests(null);
    resetDnsCache();
    resetSystemProxyCache();
    __resetGithubReadmeCacheForTests();
    resetContext7Cache();
    for (const engine of ENGINE_REGISTRY) {
        engine.resetHealth?.();
    }
    clearDoctorProbeCache();
    runtime?.services?.search?.clearCache?.();
}

/**
 * Doctor 诊断报告构建器。
 * 编排配置收集、TCP网络探测、搜索引擎健康检查、代理状态评估与浏览器可用性诊断。
 */
export async function buildDoctorReport(
    runtime: MyWebSearchRuntime,
    options: {
        env?: NodeJS.ProcessEnv;
        cwd?: string;
        version?: string;
        proxyProbeTimeoutMs?: number;
        network?: boolean;
        browser?: boolean;
        browserProbeTimeoutMs?: number;
        browserProbeFn?: (
            appConfig: AppConfig,
            timeoutMs: number
        ) => Promise<BrowserLaunchProbeResult>;
        engines?: string[];
        probeCacheTtlMs?: number;
        challengeProbeCacheTtlMs?: number;
        failureProbeCacheTtlMs?: number;
        networkProbeTimeoutMs?: number;
        networkProbeFn?: (
            engine: string,
            appConfig: AppConfig,
            timeoutMs: number
        ) => Promise<EngineNetworkProbeResult>;
        resetHealth?: boolean;
    } = {}
): Promise<DoctorReport> {
    if (options.resetHealth) {
        resetAllHealthState(runtime);
    }
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const version = options.version ?? 'unknown';
    const checkedAt = new Date().toISOString();
    const probeTimeoutMs = options.proxyProbeTimeoutMs ?? 1000;
    const networkChecked = options.network !== undefined
        ? Boolean(options.network)
        : Boolean(options.engines && options.engines.length > 0);
    const browserChecked = Boolean(options.browser);
    const browserProbeTimeoutMs = options.browserProbeTimeoutMs ?? 8000;
    const networkProbeTimeoutMs = options.networkProbeTimeoutMs ?? 3000;
    const rawProbeNetwork = options.networkProbeFn ?? probeEngineHttpEndpoint;
    const okCacheTtlMs = options.probeCacheTtlMs ?? (options.networkProbeFn ? 0 : DEFAULT_DOCTOR_PROBE_OK_TTL_MS);
    const challengeCacheTtlMs = options.challengeProbeCacheTtlMs
        ?? (options.probeCacheTtlMs !== undefined ? options.probeCacheTtlMs : (options.networkProbeFn ? 0 : DEFAULT_DOCTOR_PROBE_CHALLENGE_TTL_MS));
    const failureCacheTtlMs = options.failureProbeCacheTtlMs
        ?? (options.probeCacheTtlMs !== undefined ? options.probeCacheTtlMs : (options.networkProbeFn ? 0 : DEFAULT_DOCTOR_PROBE_FAILURE_TTL_MS));

    // 1. 配置快照与有效配置收集
    const { configSources } = collectDoctorConfigSources(env, cwd);
    const effectiveConfig = buildDoctorEffectiveConfig(runtime.config, env);

    // 2. 代理基础 TCP 探针
    const effectiveProxyServer = getProxyUrl(runtime.config);
    const proxyProbe = runtime.config.useProxy && effectiveProxyServer
        ? await probeTcpEndpoint(effectiveProxyServer, probeTimeoutMs)
        : null;

    // 3. 浏览器诊断 (CDP / 本地可执行文件 / 启动测试)
    const browserInfo = await evaluateBrowserDoctor(runtime.config, {
        browserChecked,
        browserProbeTimeoutMs,
        proxyProbeTimeoutMs: probeTimeoutMs,
        env,
        browserProbeFn: options.browserProbeFn
    });

    // 4. 搜索引擎可用性探测与缓存评估
    const probeOptions: CachedEngineProbeOptions = {
        rawProbeNetwork,
        okCacheTtlMs,
        challengeCacheTtlMs,
        failureCacheTtlMs,
        effectiveProxyServer
    };
    const { engines, probedEngines } = await evaluateEnginesDoctor(runtime.config, {
        explicitEngines: options.engines,
        networkChecked,
        networkProbeTimeoutMs,
        rawProbeNetwork,
        okCacheTtlMs,
        challengeCacheTtlMs,
        failureCacheTtlMs,
        effectiveProxyServer,
        proxyProbe,
        hasExaApiKey: Boolean(env.EXA_API_KEY?.trim()),
        checkedAt
    });

    // 5. 代理端到端上游状态综合判定
    const { proxy } = await evaluateProxyDoctor(runtime.config, {
        proxyProbeTimeoutMs: probeTimeoutMs,
        networkChecked,
        engines,
        proxyTcpProbe: proxyProbe,
        probeUpstreamFallback: async () => {
            return probeNetworkWithCache('duckduckgo', runtime.config, networkProbeTimeoutMs, probeOptions);
        }
    });

    // 6. 综合修复与配置建议
    const recommendations = generateDoctorRecommendations({
        useProxy: runtime.config.useProxy,
        effectiveProxyServer,
        proxyProbe,
        proxyStatus: proxy.status,
        networkChecked,
        proxyError: proxy.error,
        engines,
        browserInfo,
        browserChecked,
        defaultSearchEngine: runtime.config.defaultSearchEngine,
        allowedList: runtime.config.allowedSearchEngines,
        hasExaApiKey: Boolean(env.EXA_API_KEY?.trim()),
        env
    });

    const networkNotice = networkChecked
        ? 'Live network probes sent to target engines (using minimal result count and short-TTL cache). Avoid high-frequency execution to prevent upstream anti-bot rate limits.'
        : undefined;

    return {
        version,
        checkedAt,
        networkChecked,
        browserChecked,
        ...(networkNotice ? { networkNotice } : {}),
        ...(networkChecked
            ? {
                probeUserAgent: BROWSER_USER_AGENT,
                cachePolicy: {
                    okTtlMs: okCacheTtlMs,
                    challengeTtlMs: challengeCacheTtlMs,
                    failureTtlMs: failureCacheTtlMs
                }
            }
            : {}),
        probedEngines,
        configSources,
        effectiveConfig,
        proxy,
        browser: browserInfo,
        engines,
        recommendations,
        ...(options.resetHealth ? { healthReset: true } : {})
    };
}
