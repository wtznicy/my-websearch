import axios, { AxiosError } from 'axios';
import type { AxiosRequestConfig, AxiosResponse, RawAxiosRequestHeaders, ResponseType } from 'axios';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
    RequestFilteringHttpAgent,
    RequestFilteringHttpsAgent
} from 'request-filtering-agent';
import { config, getProxyUrl, engineShouldUseProxy } from '../config.js';
import { assertPublicHttpUrlResolved, isPrivateOrLocalHostname } from './urlSafety.js';
import { cachedDnsLookup, peekCachedLookup } from './dnsCache.js';
import { metrics } from '../core/metrics.js';

// 默认请求超时：调用方未显式传 timeout 时使用，避免引擎请求永不超时拖垮整个搜索。
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

// keepAlive + 并发上限：同一 agent 的多次请求（sogou link 解析、baidu redirect、分页、MCP 会话内多次搜索）
// 复用 TCP/TLS 连接，省掉重复握手；lookup 走进程内 DNS 缓存（60s TTL），
// request-filtering-agent 会继续对解析结果做私网过滤，SSRF 防护不削弱。
const AGENT_KEEPALIVE_OPTIONS = {
    keepAlive: true,
    maxSockets: 16,
    lookup: cachedDnsLookup
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
    'cdn.jsdelivr.net'
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
export function hintProxyConnectionError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (config.useProxy && /ECONNREFUSED|ECONNRESET|socket hang up|ENETUNREACH/i.test(message)) {
        return new Error(
            `${message} | Hint: 请求经代理 ${config.proxyUrl} 失败——请确认代理软件已启动、PROXY_URL 端口正确，或临时关闭 USE_PROXY（国内站点可直连）`
        );
    }
    return error instanceof Error ? error : new Error(message);
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
        forceDirect = false
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
    const effectiveMaxRedirects = trustedStaticHost ? 0 : maxRedirects;
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
            throw new Error('Redirect target points to a private or local network address');
        }
        // 若该 hostname 的解析结果已在 DNS 缓存中且解析到私网地址，同步拦截
        // （覆盖"重定向到域名、而该域名此前已解析到私网 IP"的场景，不发起新 DNS 查询）
        if (target) {
            const cachedAddresses = peekCachedLookup(target);
            if (cachedAddresses && cachedAddresses.some((address) => isPrivateOrLocalHostname(address))) {
                throw new Error(`Redirect target "${target}" resolves to a private or local network address (cached DNS)`);
            }
        }
    };

    const effectiveProxyUrl = forceDirect
        ? undefined
        : (engine !== undefined
            ? (engineShouldUseProxy(engine) ? getProxyUrl() : undefined)
            : getProxyUrl());
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
                throw new Error('allowInsecureTls + trustedStaticHost requires an explicit requestUrl for the trusted-host whitelist check');
            }
            let host: string;
            try {
                host = new URL(options.requestUrl).hostname.toLowerCase();
            } catch {
                throw new Error(`allowInsecureTls + trustedStaticHost: invalid requestUrl "${options.requestUrl}"`);
            }
            if (!TRUSTED_INSECURE_HOSTS.has(host)) {
                throw new Error(`allowInsecureTls + trustedStaticHost is not allowed for host "${host}". Allowed hosts: ${[...TRUSTED_INSECURE_HOSTS].join(', ')}`);
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

/** 网络层错误判定（超时/连接拒绝/重置/不可达/DNS 失败等）；HTTP 状态类错误不算 */
export function isNetworkLayerError(message: string): boolean {
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|network error|fetch failed|ERR_NETWORK|timeout of \d+ms/i.test(message);
}

/**
 * 直连优先、代理兜底的请求（供 fetchWebContent / fetchCsdnArticle / fetchJuejinArticle 等通用抓取）：
 * 1. 先无代理直连（快、国内站点最优，不依赖代理可用性）；
 * 2. 网络层失败（超时/连接错误，非 HTTP 状态错误）时：
 *    - 已配置代理（USE_PROXY=true + PROXY_URL）→ 走代理重试一次；代理也失败 → 附加"代理不可达"提示；
 *    - 未配置代理 → 错误附加"开启代理"提示（目标站点可能无法从当前网络直连）。
 * buildOptions 接收 forceDirect 决定请求是否挂代理，调用方用它构造 AxiosRequestConfig。
 */
export async function requestDirectFirst(
    method: 'GET' | 'HEAD',
    url: string,
    buildOptions: (forceDirect: boolean) => AxiosRequestConfig,
    urlLabel: string = 'Request URL'
): Promise<AxiosResponse> {
    try {
        return await requestWithSafeRedirects(method, url, buildOptions(true), urlLabel);
    } catch (directError) {
        const message = directError instanceof Error ? directError.message : String(directError);
        if (!isNetworkLayerError(message)) {
            throw directError;
        }
        if (config.useProxy && config.proxyUrl) {
            try {
                return await requestWithSafeRedirects(method, url, buildOptions(false), urlLabel);
            } catch (proxyError) {
                throw hintProxyConnectionError(proxyError);
            }
        }
        throw new Error(
            `${message} | Hint: 直连失败——目标站点可能无法从当前网络直接访问；可开启代理（USE_PROXY=true + PROXY_URL，如 http://127.0.0.1:7890）后重试`
        );
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
    let currentUrl = initialUrl;

    for (let hops = 0; hops <= maxRedirects; hops++) {
        await assertPublicHttpUrlResolved(currentUrl, hops === 0 ? urlLabel : 'Redirect target');

        const response = await axiosRequestImpl({
            ...options,
            method,
            url: currentUrl,
            maxRedirects: 0,
            // Accept 3xx here so we can inspect Location; caller's validateStatus
            // is re-applied to the final non-3xx response below.
            validateStatus: (s) => s >= 200 && s < 400,
        });

        const location = response.status >= 300 && response.status < 400
            ? response.headers?.location
            : undefined;

        if (location) {
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

    throw new Error(`Too many redirects (max ${maxRedirects})`);
}
