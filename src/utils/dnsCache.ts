import dns from 'node:dns';
import { Resolver as PromisesResolver } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * 进程内 DNS 解析缓存（短 TTL）与非阻塞解析器。
 *
 * 背景：
 * 1. Node.js 默认的 `dns.lookup` 走操作系统的 `getaddrinfo`，在 libuv 线程池（默认仅 4 个线程）中同步执行。
 *    高并发解析跳转链或 SSRF 校验时，4 个线程迅速被打满，导致进程内所有文件 I/O、Crypto 与后续 DNS 全部排队阻塞。
 * 2. 采用非阻塞 c-ares Resolver 作为首选解析（不消耗 libuv 线程池），失败或本地域名（.local/hosts 等）回退至 dns.lookup；
 * 3. 引入 in-flight 单飞去重机制（Request Coalescing）：同一 host 并发多次查询合并为单次底层解析，彻底杜绝瞬间并发冲垮线程池；
 * 4. 成功结果保持 60s 内存缓存，IP 地址与 localhost 直通返回。
 */

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

type CacheEntry = {
    addresses: string[];
    family: number;
    all: boolean;
    expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now > entry.expiresAt) {
            cache.delete(key);
        }
    }
    while (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        cache.delete(oldest);
    }
}

/** 与 Node http.AgentOptions.lookup 兼容的签名（address 必选） */
export type DnsLookupFn = (
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
) => void;

// 独立 c-ares Resolver 实例（纯网络异步事件循环，不占用 libuv 线程池）
const caresResolver = new PromisesResolver();
try {
    caresResolver.setServers(['223.5.5.5', '119.29.29.29', '1.1.1.1', '8.8.8.8']);
} catch {
    // 忽略特定沙箱环境下 setServers 报错
}

/** 默认底层非阻塞解析实现 */
function defaultLookupImpl(
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
    // ① IPv4 / IPv6 字面量直通（无需任何 DNS 解析，0ms / 0 线程消耗）
    const ipFamily = isIP(hostname);
    if (ipFamily !== 0) {
        if (options.all) {
            callback(null, [{ address: hostname, family: ipFamily }]);
        } else {
            callback(null, hostname, ipFamily);
        }
        return;
    }

    // ② localhost 直通
    if (hostname.toLowerCase() === 'localhost') {
        if (options.all) {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
        } else {
            callback(null, '127.0.0.1', 4);
        }
        return;
    }

    // ③ 首选 c-ares Resolver（非阻塞事件循环，不占用 libuv 线程池）
    const resolvePromise = (options.family === 6)
        ? caresResolver.resolve6(hostname)
        : caresResolver.resolve4(hostname);

    resolvePromise
        .then((ips) => {
            if (!ips || ips.length === 0) {
                throw new Error('No addresses returned');
            }
            const family = options.family === 6 ? 6 : 4;
            if (options.all) {
                const addrs: dns.LookupAddress[] = ips.map((ip) => ({ address: ip, family }));
                callback(null, addrs);
            } else {
                callback(null, ips[0] ?? '', family);
            }
        })
        .catch(() => {
            // ④ c-ares 失败（如本地 intranet、hosts 文件域名、特定网络环境）时安全回退至系统 dns.lookup
            dns.lookup(hostname, options, (err, address, family) => {
                callback(err, address, family);
            });
        });
}

/** 真实解析实现（测试可通过 __setDnsLookupForTests 替换） */
let lookupImpl: DnsLookupFn = defaultLookupImpl;

export function __setDnsLookupForTests(impl?: DnsLookupFn): void {
    lookupImpl = impl ?? defaultLookupImpl;
}

/**
 * 同步读取某 hostname 的缓存解析结果（无缓存返回 undefined）。
 * 供同步安全钩子（如 axios beforeRedirect）在不发起新 DNS 查询的前提下
 * 检查重定向目标是否解析到私网地址。
 */
export function peekCachedLookup(hostname: string): string[] | undefined {
    const entry = cache.get(hostname.toLowerCase());
    if (entry && Date.now() < entry.expiresAt) {
        return entry.addresses;
    }
    return undefined;
}

/** 并发单飞去重映射表：同一 host 在并发查询时复用同一个进行中的 Promise */
type InFlightResult = {
    err: NodeJS.ErrnoException | null;
    address: string | dns.LookupAddress[];
    family?: number;
};
const inFlight = new Map<string, Promise<InFlightResult>>();

export const cachedDnsLookup: DnsLookupFn = (hostname, options, callback) => {
    const now = Date.now();
    const cleanHost = hostname.toLowerCase();
    const cacheKey = `${cleanHost}:${!!options.all}:${options.family ?? 'any'}`;

    const cached = cache.get(cleanHost);
    if (cached && now < cached.expiresAt && cached.all === !!options.all) {
        if (options.all) {
            callback(null, cached.addresses.map((address) => ({ address, family: cached.family })));
        } else {
            callback(null, cached.addresses[0] ?? '', cached.family);
        }
        return;
    }

    // 检查是否有相同的并发查询正在执行（In-flight Coalescing，防止并发冲垮线程池）
    const existingPromise = inFlight.get(cacheKey);
    if (existingPromise) {
        existingPromise
            .then((result) => {
                callback(result.err, result.address, result.family);
            })
            .catch((err) => {
                callback(err, '');
            });
        return;
    }

    const pending: Promise<InFlightResult> = new Promise<InFlightResult>((resolve) => {
        lookupImpl(hostname, options, (err, ...rest) => {
            const address = rest[0] as string | dns.LookupAddress[];
            const family = rest[1] as number | undefined;

            if (!err) {
                const addresses = options.all
                    ? (address as dns.LookupAddress[])
                    : [{ address: address as string, family: family as number }];
                const first = addresses[0];
                if (addresses.length > 0 && first && first.address) {
                    evictExpired();
                    cache.set(cleanHost, {
                        addresses: addresses.map((item) => item.address),
                        family: first.family ?? 4,
                        all: !!options.all,
                        expiresAt: now + CACHE_TTL_MS
                    });
                }
            }

            resolve({ err, address, family });
        });
    }).finally(() => {
        inFlight.delete(cacheKey);
    });

    inFlight.set(cacheKey, pending);

    pending.then((result) => {
        callback(result.err, result.address, result.family);
    }).catch((err) => {
        callback(err, '');
    });
};
