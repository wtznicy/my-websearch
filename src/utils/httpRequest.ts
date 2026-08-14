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
import { cachedDnsLookup } from './dnsCache.js';

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
};

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
        validateStatus
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
    };

    const effectiveProxyUrl = engine !== undefined
        ? (engineShouldUseProxy(engine) ? getProxyUrl() : undefined)
        : getProxyUrl();
    if (effectiveProxyUrl) {
        const proxyAgent = getProxyAgent(effectiveProxyUrl, allowInsecureTls);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    } else if (trustedStaticHost) {
        // 修复固定域名 axios 请求在部分网络中失败的问题：搜索/API 域名可能解析到
        // 100.64.0.0/10 这类运营商/代理地址而被 request-filtering-agent 拦截。
        // 该开关只允许用于调用方生成的固定可信 host，并强制禁用重定向，避免扩大 SSRF 面。
        if (allowInsecureTls) {
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
