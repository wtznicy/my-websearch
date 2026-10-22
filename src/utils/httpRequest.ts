import axios, { AxiosError } from 'axios';
import type { AxiosRequestConfig, AxiosResponse, RawAxiosRequestHeaders, ResponseType } from 'axios';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
    RequestFilteringHttpAgent,
    RequestFilteringHttpsAgent
} from 'request-filtering-agent';
import { config, getProxyUrl, engineShouldUseProxy } from '../config.js';
import { assertPublicHttpUrlResolved, isDnsPollutionAddress, isPrivateOrLocalHostname, stripDnsPollutionAddresses } from './urlSafety.js';
import type { DnsLookupFn } from './dnsCache.js';
import { cachedDnsLookup, peekCachedLookup } from './dnsCache.js';
import { detectSystemProxy, getSystemProxyFallbackUrl } from './systemProxy.js';
import { metrics } from '../core/metrics.js';
import { AppError } from '../core/errors.js';

// 默认请求超时：调用方未显式传 timeout 时使用，避免引擎请求永不超时拖垮整个搜索。
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

// keepAlive + 并发上限：同一 agent 的多次请求（sogou link 解析、baidu redirect、分页、MCP 会话内多次搜索）
// 复用 TCP/TLS 连接，省掉重复握手；lookup 走进程内 DNS 缓存（60s TTL），
// request-filtering-agent 会继续对解析结果做私网过滤，SSRF 防护不削弱。
const filteredDnsLookup: DnsLookupFn = (hostname, options, callback) => {
    cachedDnsLookup(hostname, options, (error, address, family) => {
        if (error) {
            callback(error, address, family);
            return;
        }
        if (Array.isArray(address)) {
            // 二层防护不一致的修复：先把 DNS 污染地址剔掉，再交给 request-filtering-agent
            callback(null, stripDnsPollutionAddresses(address));
            return;
        }
        if (typeof address === 'string' && isDnsPollutionAddress(address)) {
            // 单一地址就是污染地址：没有更好的选择，交给连接层报错（上层会映射成"疑似 DNS 污染"）
            callback(null, address, family);
            return;
        }
        callback(null, address, family);
    });
};

const AGENT_KEEPALIVE_OPTIONS = {
    keepAlive: true,
    maxSockets: 16,
    lookup: filteredDnsLookup
} as const;

type BuildAxiosRequestOptions = {
    allowInsecureTls?: boolean;
    // 搜索引擎名（如 'bing'/'baidu'）。传入后按 PROXY_ENGINES 白名单决定是否挂代理；
    // 不传（undefined）则跟随全局 USE_PROXY 开关（旧行为）。
    engine?: string;
    decompress?: boolean;
    headers?: RawAxiosRequestHeaders;
    maxBodyLength?: number;
    maxContentLength?: number;
    maxRedirects?: number;
    params?: unknown;
    responseType?: ResponseType;
    timeout?: number;
    trustedStaticHost?: boolean;
    validateStatus?: AxiosRequestConfig['validateStatus'];
    // 目标请求 URL。allowInsecureTls + trustedStaticHost 组合时必填，
    // 用于白名单校验（见 TRUSTED_INSECURE_HOSTS）。
    requestUrl?: string;
    // 强制直连（不走代理）：用于国内站点网页抓取——全局 USE_PROXY 会拖累 .cn 等
    // 国内目标（代理一挂国内抓取全挂），国内站点直连、海外才走代理。
    forceDirect?: boolean;
    signal?: AbortSignal;
};

/**
 * 允许 allowInsecureTls + trustedStaticHost 组合（关闭 TLS 证书校验）的固定可信域名白名单。
 * 该组合会关掉全部 TLS 防护，绝不允许用于用户输入 URL——只能用于代码内硬编码的
 * 引擎固定域名。未来新增使用点必须先把域名加进此白名单，否则运行时抛错。
 */
const TRUSTED_INSECURE_HOSTS = new Set([
    'cn.bing.com',
    'www.bing.com',
    'www.baidu.com',
    'search.brave.com',
    'api.search.brave.com',
    'duckduckgo.com',
    'html.duckduckgo.com',
    'so.csdn.net',
    'blog.csdn.net',
    'api.exa.ai',
    'api.github.com',
    'raw.githubusercontent.com',
    'gitee.com',
    'api.gitee.com',
    'juejin.cn',
    'api.juejin.cn',
    'www.sogou.com',
    'www.startpage.com',
    'cdn.jsdelivr.net',
    'api.stackexchange.com',
    'hn.algolia.com',
    'export.arxiv.org'
]);

const filteringHttpAgents = new Map<string, RequestFilteringHttpAgent>();
const secureFilteringHttpsAgents = new Map<string, RequestFilteringHttpsAgent>();
const insecureFilteringHttpsAgents = new Map<string, RequestFilteringHttpsAgent>();
let insecureTrustedStaticHttpsAgent: https.Agent | null = null;
const proxyAgents = new Map<string, HttpsProxyAgent<string>>();

function buildFakeIpAgentCacheKey(): string {
    return config.fakeIpCidrs.join(',');
}

// Allow configured synthetic fake-ip CIDRs through request-filtering-agent
// so TUN/no-proxy paths do not re-block addresses already declared as fake DNS results.
function buildFakeIpAllowlistOptions() {
    return config.fakeIpCidrs.length > 0 ? { allowIPAddressList: config.fakeIpCidrs } : {};
}

function getFilteringHttpAgent(): RequestFilteringHttpAgent {
    const cacheKey = buildFakeIpAgentCacheKey();
    const cached = filteringHttpAgents.get(cacheKey);
    if (cached) {
        return cached;
    }
    const agent = new RequestFilteringHttpAgent({
        ...buildFakeIpAllowlistOptions(),
        ...AGENT_KEEPALIVE_OPTIONS
    });
    filteringHttpAgents.set(cacheKey, agent);
    return agent;
}

function getFilteringHttpsAgent(allowInsecureTls: boolean): RequestFilteringHttpsAgent {
    const cacheKey = `${allowInsecureTls ? 'insecure' : 'secure'}::${buildFakeIpAgentCacheKey()}`;
    const cache = allowInsecureTls ? insecureFilteringHttpsAgents : secureFilteringHttpsAgents;
    const cached = cache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const agent = new RequestFilteringHttpsAgent({
        ...buildFakeIpAllowlistOptions(),
        rejectUnauthorized: !allowInsecureTls,
        ...AGENT_KEEPALIVE_OPTIONS
    });
    cache.set(cacheKey, agent);
    return agent;
}

function getProxyAgent(proxyUrl: string, allowInsecureTls: boolean): HttpsProxyAgent<string> {
    const cacheKey = `${proxyUrl}::${allowInsecureTls ? 'insecure' : 'secure'}`;
    const cachedAgent = proxyAgents.get(cacheKey);
    if (cachedAgent) {
        return cachedAgent;
    }

    const agent = new HttpsProxyAgent(proxyUrl, {
        rejectUnauthorized: !allowInsecureTls,
        keepAlive: true,
        maxSockets: 16
    });
    proxyAgents.set(cacheKey, agent);
    return agent;
}

function getInsecureTrustedStaticHttpsAgent(): https.Agent {
    if (!insecureTrustedStaticHttpsAgent) {
        insecureTrustedStaticHttpsAgent = new https.Agent({
            rejectUnauthorized: false,
            keepAlive: true,
            maxSockets: 16
        });
    }
    return insecureTrustedStaticHttpsAgent;
}

/**
 * 代理连接错误提示：USE_PROXY=true 且请求失败于连接类错误（ECONNREFUSED 等）时，
 * 附加明确提示（最常见原因：代理软件没启动或 PROXY_URL 端口不对），
 * 让调用方/LLM 一眼知道是代理配置问题而不是目标站点问题。
 */
/**
 * 失败信息是否「看起来和代理有关」。
 * 除了连接被拒，还包括死代理的典型形态：连上了但不回数据（timeout / TLS eof / socket disconnected）。
 */
export function isProxyRelatedFailure(message: string): boolean {
    // 注意：不能只写 timeout —— 引擎自己的 "Engine timeout after 10000ms" 也含 timeout，
    // 那会把所有慢站点都误判成代理问题。这里只认 axios 的 "timeout of Nms exceeded"。
    return /ECONNREFUSED|ECONNRESET|socket hang up|ENETUNREACH|ETIMEDOUT|ECONNABORTED|timeout of \d+ms exceeded|TLS|unexpected eof|socket disconnected|proxy/i.test(message);
}

/**
 * 是否是确定性的「连不上代理」——这类失败重试没有意义，只会把 10s 拉成 30s。
 * 普通 timeout 不算（可能只是站点慢），仍然保留重试。
 */
export function isDeterministicProxyFailure(message: string): boolean {
    return /ECONNREFUSED|ENETUNREACH|ECONNRESET|socket hang up|TLS|unexpected eof|socket disconnected/i.test(message);
}

export function hintProxyConnectionError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (config.useProxy && isProxyRelatedFailure(message)) {
        return new AppError({
            code: 'proxy_unreachable',
            retryable: !isDeterministicProxyFailure(message),
            cause: error instanceof Error ? error : undefined,
            message: `${message} | Hint: request via proxy ${config.proxyUrl} failed. `
                + 'Check that the proxy is running and PROXY_URL is correct, or set USE_PROXY=false to go direct. '
                + `请求经代理 ${config.proxyUrl} 失败：请确认代理已启动、PROXY_URL 正确，或设置 USE_PROXY=false 直连。`
        });
    }
    return error instanceof Error ? error : new Error(message);
}

/**
 * 连接层报「private IP / not allowed」时，实际多半是 DNS 污染：
 * 解析结果里混入了伪造地址，而我们的第一层判定（urlSafety）认为「存在公网地址即可放行」。
 * 这条提示让用户能采取行动，而不是对着 "private IP address" 猜。
 */
export function hintDnsPollutionError(error: unknown): unknown {
    const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
    if (/is not allowed.*(private IP|local IP)|private IP address/i.test(message)) {
        return new AppError({
            code: 'dns_pollution',
            retryable: true,
            cause: error instanceof Error ? error : undefined,
            message: `${message} | Hint: the hostname resolved to a private or polluted address (likely DNS pollution). `
                + 'Retry, enable a proxy (USE_PROXY=true or PROXY_URL), or switch DNS. '
                + `域名解析到私网/污染地址（疑似 DNS 污染）：建议重试、开启代理或更换 DNS。`
        });
    }
    // 原样返回：axios 的错误对象上可能挂着 response.status 等字段，包一层会丢掉它们
    return error;
}

export function buildAxiosRequestOptions(options: BuildAxiosRequestOptions = {}): AxiosRequestConfig {
    const {
        allowInsecureTls = false,
        engine,
        decompress,
        headers,
        maxBodyLength,
        maxContentLength,
        maxRedirects,
        params,
        responseType,
        timeout = DEFAULT_REQUEST_TIMEOUT_MS,
        trustedStaticHost = false,
        validateStatus,
        forceDirect = false,
        signal
    } = options;

    const requestOptions: AxiosRequestConfig = {
        proxy: false
    };

    if (headers) {
        requestOptions.headers = headers;
    }
    if (timeout !== undefined) {
        requestOptions.timeout = timeout;
    }
    if (signal !== undefined) {
        requestOptions.signal = signal;
    }
    const effectiveMaxRedirects = maxRedirects ?? (trustedStaticHost ? 0 : undefined);
    if (effectiveMaxRedirects !== undefined) {
        requestOptions.maxRedirects = effectiveMaxRedirects;
    }
    if (responseType !== undefined) {
        requestOptions.responseType = responseType;
    }
    if (maxContentLength !== undefined) {
        requestOptions.maxContentLength = maxContentLength;
    }
    if (maxBodyLength !== undefined) {
        requestOptions.maxBodyLength = maxBodyLength;
    }
    if (decompress !== undefined) {
        requestOptions.decompress = decompress;
    }
    if (validateStatus !== undefined) {
        requestOptions.validateStatus = validateStatus;
    }
    if (params !== undefined) {
        requestOptions.params = params;
    }

    // Sync-only hook (follow-redirects constraint) — catches literal-IP
    // private targets. Hostname-on-redirect in proxy mode still relies on
    // the initial-URL DNS check.
    requestOptions.beforeRedirect = (opts) => {
        const target = (opts.hostname ?? opts.host) as string | undefined;
        if (target && isPrivateOrLocalHostname(target)) {
            throw new AppError({
                code: 'redirect_not_allowed',
                retryable: false,
                message: 'Redirect target points to a private or local network address'
            });
        }
        // 若该 hostname 的解析结果已在 DNS 缓存中且解析到私网地址，同步拦截
        // （覆盖"重定向到域名、而该域名此前已解析到私网 IP"的场景，不发起新 DNS 查询）
        if (target) {
            const cachedAddresses = peekCachedLookup(target);
            if (cachedAddresses && cachedAddresses.some((address) => isPrivateOrLocalHostname(address))) {
                throw new AppError({
                    code: 'redirect_not_allowed',
                    retryable: false,
                    message: `Redirect target "${target}" resolves to a private or local network address (cached DNS)`
                });
            }
        }
    };

    const effectiveProxyUrl = forceDirect
        ? undefined
        : (engine !== undefined
            ? (engineShouldUseProxy(engine) ? getProxyUrl() : getSystemProxyFallbackUrl(engine))
            : (getProxyUrl() ?? getSystemProxyFallbackUrl(undefined)));
    if (effectiveProxyUrl) {
        const proxyAgent = getProxyAgent(effectiveProxyUrl, allowInsecureTls);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    } else if (trustedStaticHost) {
        // 修复固定域名 axios 请求在部分网络中失败的问题：搜索/API 域名可能解析到
        // 100.64.0.0/10 这类运营商/代理地址而被 request-filtering-agent 拦截。
        // 该开关只允许用于调用方生成的固定可信 host，并强制禁用重定向，避免扩大 SSRF 面。
        if (allowInsecureTls) {
            // 安全断言：该组合会关闭 TLS 证书校验，只允许用于显式声明的固定可信域名，
            // 防止未来某段代码把用户输入的 URL 传入（中间人/降级攻击面）。
            if (!options.requestUrl) {
                throw new AppError({
                    code: 'invalid_config',
                    retryable: false,
                    message: 'allowInsecureTls + trustedStaticHost requires an explicit requestUrl for the trusted-host whitelist check'
                });
            }
            let host: string;
            try {
                host = new URL(options.requestUrl).hostname.toLowerCase();
            } catch {
                throw new AppError({
                    code: 'invalid_config',
                    retryable: false,
                    message: `allowInsecureTls + trustedStaticHost: invalid requestUrl "${options.requestUrl}"`
                });
            }
            if (!TRUSTED_INSECURE_HOSTS.has(host)) {
                throw new AppError({
                    code: 'invalid_config',
                    retryable: false,
                    message: `allowInsecureTls + trustedStaticHost is not allowed for host "${host}". Allowed hosts: ${[...TRUSTED_INSECURE_HOSTS].join(', ')}`
                });
            }
            // 审计日志：TLS 白名单实际触发时记录，便于安全审计
            metrics.recordSecurityEvent({
                type: 'tls_failed',
                targetUrl: options.requestUrl,
                reason: `TLS certificate verification bypassed for trusted host "${host}"`,
                details: { host, engine }
            });
            requestOptions.httpsAgent = getInsecureTrustedStaticHttpsAgent();
        }
    } else {
        requestOptions.httpAgent = getFilteringHttpAgent();
        requestOptions.httpsAgent = getFilteringHttpsAgent(allowInsecureTls);
    }

    return requestOptions;
}

type AxiosRequestFn = (config: AxiosRequestConfig) => Promise<AxiosResponse>;

let axiosRequestImpl: AxiosRequestFn = (config) => axios.request(config);

export function __setAxiosRequestForTests(impl?: AxiosRequestFn): void {
    axiosRequestImpl = impl ?? ((config) => axios.request(config));
}

function createAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new AppError({ code: 'aborted', retryable: false, message: 'Request aborted' });
}

function requestWithSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    if (!signal) {
        return fn();
    }
    if (signal.aborted) {
        return Promise.reject(createAbortError(signal));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(createAbortError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        fn().then(
            (val) => {
                signal.removeEventListener('abort', onAbort);
                resolve(val);
            },
            (err) => {
                signal.removeEventListener('abort', onAbort);
                reject(err);
            }
        );
    });
}

/** 网络层错误判定（超时/连接拒绝/重置/不可达/DNS 失败等）；HTTP 状态类错误不算 */
export function isNetworkLayerError(message: string): boolean {
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|network error|fetch failed|ERR_NETWORK|timeout of \d+ms/i.test(message);
}

/**
 * P1-3：直连慢/不可达主机记忆缓存（进程内 5 分钟 TTL，上限 128 个域名）：
 * 当某域名在直连探测时超时/网络失败、且随后通过代理成功访问时，记住该域名在当前网络需走代理；
 * 后续对该域名的 requestDirectFirst 请求直接优先走代理，省去每次先白等直连超时的代价。
 */
const DIRECT_SLOW_HOST_TTL_MS = 5 * 60 * 1000;
const MAX_DIRECT_SLOW_HOST_ENTRIES = 128;
const DEFAULT_DIRECT_FIRST_PROBE_TIMEOUT_MS = 3500;
const directSlowHostCache = new Map<string, number>();

function extractHostname(url: string): string | null {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

export function isHostMarkedDirectSlow(url: string, now = Date.now()): boolean {
    const host = extractHostname(url);
    if (!host) {
        return false;
    }
    const expiresAt = directSlowHostCache.get(host);
    if (expiresAt === undefined) {
        return false;
    }
    if (now >= expiresAt) {
        directSlowHostCache.delete(host);
        return false;
    }
    return true;
}

function markHostDirectSlow(url: string, now = Date.now()): void {
    const host = extractHostname(url);
    if (!host) {
        return;
    }
    if (directSlowHostCache.has(host)) {
        directSlowHostCache.delete(host);
    } else if (directSlowHostCache.size >= MAX_DIRECT_SLOW_HOST_ENTRIES) {
        const oldest = directSlowHostCache.keys().next().value;
        if (oldest !== undefined) {
            directSlowHostCache.delete(oldest);
        }
    }
    directSlowHostCache.set(host, now + DIRECT_SLOW_HOST_TTL_MS);
}

export function __resetDirectSlowHostCacheForTests(): void {
    directSlowHostCache.clear();
}

/**
 * 直连优先、代理兜底的请求（供 fetchWebContent / fetchCsdnArticle / fetchJuejinArticle 等通用抓取）：
 * 1. 若已配置代理且目标域名近期已证实"直连不通、代理可达"，直接走代理（代理网络故障时再兜底直连）；
 * 2. 否则先无代理直连（当已配置代理兜底时，将直连试探超时收敛到 ≤3.5s，避免境外慢连接每次挂满 10~15s）；
 * 3. 网络层失败（超时/连接错误，非 HTTP 状态错误）时：
 *    - 已配置代理（USE_PROXY=true + PROXY_URL）→ 走代理重试一次，成功则记入 directSlowHostCache；
 *    - 未配置代理 → 错误附加"开启代理"提示（目标站点可能无法从当前网络直连）。
 */
export async function requestDirectFirst(
    method: 'GET' | 'HEAD',
    url: string,
    buildOptions: (forceDirect: boolean) => AxiosRequestConfig,
    urlLabel: string = 'Request URL'
): Promise<AxiosResponse> {
    const hasConfiguredProxy = Boolean(config.useProxy && config.proxyUrl);
    // 自动检测到的系统代理同样算「有代理可用」：否则只开了系统代理、没配 PROXY_URL 的用户
    // 在直连失败时不会回退到代理，只会拿到一个 network_error（arxiv 采样失败就是这个形态）。
    const systemProxyUrl = hasConfiguredProxy ? null : await detectSystemProxy();
    const hasProxyAvailable = hasConfiguredProxy || Boolean(systemProxyUrl);
    if (hasProxyAvailable && isHostMarkedDirectSlow(url)) {
        const proxyOptions = buildOptions(false);
        try {
            return await requestWithSafeRedirects(method, url, proxyOptions, urlLabel);
        } catch (proxyError) {
            if (proxyOptions.signal?.aborted) {
                throw proxyError;
            }
            const proxyMsg = proxyError instanceof Error ? proxyError.message : String(proxyError);
            if (!isNetworkLayerError(proxyMsg)) {
                throw proxyError;
            }
            // 代理突发不可达时清除慢主机标记并回退直连试一次
            const host = extractHostname(url);
            if (host) {
                directSlowHostCache.delete(host);
            }
            try {
                return await requestWithSafeRedirects(method, url, buildOptions(true), urlLabel);
            } catch {
                throw hintProxyConnectionError(proxyError);
            }
        }
    }

    const rawDirectOptions = buildOptions(true);
    const probeTimeoutCap = Number(process.env.DIRECT_FIRST_PROBE_TIMEOUT_MS) || DEFAULT_DIRECT_FIRST_PROBE_TIMEOUT_MS;
    const directOptions: AxiosRequestConfig = hasConfiguredProxy
        && typeof rawDirectOptions.timeout === 'number'
        && rawDirectOptions.timeout > probeTimeoutCap
        ? { ...rawDirectOptions, timeout: probeTimeoutCap }
        : rawDirectOptions;

    try {
        return await requestWithSafeRedirects(method, url, directOptions, urlLabel);
    } catch (directError) {
        if (directOptions.signal?.aborted) {
            throw directError;
        }
        const message = directError instanceof Error ? directError.message : String(directError);
        if (!isNetworkLayerError(message)) {
            // 「private IP / not allowed」不是网络层错误，但十有八九是 DNS 污染
            throw hintDnsPollutionError(directError);
        }
        if (hasProxyAvailable) {
            try {
                const response = await requestWithSafeRedirects(method, url, buildOptions(false), urlLabel);
                markHostDirectSlow(url);
                return response;
            } catch (proxyError) {
                throw hintProxyConnectionError(proxyError);
            }
        }
        throw new AppError({
            code: 'network_error',
            retryable: true,
            cause: directError,
            message: `${message} | Hint: 直连失败——目标站点可能无法从当前网络直接访问；可配置代理（PROXY_URL，如 http://127.0.0.1:7897）后重试`
        });
    }
}

// Manually chase redirects so we can async-DNS-resolve each hop. follow-redirects'
// beforeRedirect hook is sync, so in proxy mode (no request-filtering-agent) a
// redirect to a hostname resolving to 127.0.0.1 would otherwise slip through.
export async function requestWithSafeRedirects(
    method: 'GET' | 'HEAD',
    initialUrl: string,
    options: AxiosRequestConfig = {},
    urlLabel: string = 'Request URL'
): Promise<AxiosResponse> {
    const maxRedirects = options.maxRedirects ?? 5;
    const validateStatus = options.validateStatus ?? ((s: number) => s >= 200 && s < 300);
    const signal = options.signal as AbortSignal | undefined;
    let currentUrl = initialUrl;

    for (let hops = 0; hops <= maxRedirects; hops++) {
        if (signal?.aborted) {
            throw createAbortError(signal);
        }
        await assertPublicHttpUrlResolved(currentUrl, hops === 0 ? urlLabel : 'Redirect target');

        if (signal?.aborted) {
            throw createAbortError(signal);
        }

        const response = await requestWithSignal(signal, () => axiosRequestImpl({
            ...options,
            method,
            url: currentUrl,
            maxRedirects: 0,
            // Accept 3xx here so we can inspect Location; caller's validateStatus
            // is re-applied to the final non-3xx response below.
            validateStatus: (s) => s >= 200 && s < 400,
        }));

        const location = response.status >= 300 && response.status < 400
            ? response.headers?.location
            : undefined;

        if (location) {
            // stopOnRedirect 或 maxRedirects === 0：调用方需要读取 3xx 响应本身（如 Set-Cookie 在 302 上、
            // 或禁止跟随重定向以将 3xx 识别为拦截/反爬检查点，避免跟随外部重定向触发不必要的 SSRF 拦截）
            if ((options as { stopOnRedirect?: boolean }).stopOnRedirect || maxRedirects === 0) {
                return response;
            }
            currentUrl = new URL(String(location), currentUrl).toString();
            continue;
        }

        if (response.request?.res && !response.request.res.responseUrl) {
            response.request.res.responseUrl = currentUrl;
        }
        if (!validateStatus(response.status)) {
            throw new AxiosError(
                `Request failed with status code ${response.status}`,
                AxiosError.ERR_BAD_RESPONSE,
                response.config,
                response.request,
                response
            );
        }
        return response;
    }

    throw new AppError({
        code: 'redirect_not_allowed',
        retryable: false,
        message: `Too many redirects (max ${maxRedirects})`
    });
}
