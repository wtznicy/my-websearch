import dns from 'node:dns';

/**
 * 进程内 DNS 解析缓存（短 TTL）。
 *
 * 背景：axios 请求默认不复用 DNS 解析结果，同一进程内对同一域名的多次请求
 * （如 sogou 的 link 解析、baidu 的 redirect 解析、分页抓取）会重复解析。
 * 缓存成功结果（60s TTL）减少重复解析开销；失败结果不缓存（下次重试）。
 *
 * 与 SSRF 过滤兼容：request-filtering-agent 的 makeLookup 会包装本 lookup，
 * 对解析出的 IP 做私网/meta 地址过滤，防护不因缓存而削弱
 * （唯一代价：60s TTL 内的 DNS rebinding 窗口，对个人 MCP 场景可忽略）。
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
type DnsLookupFn = (
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
) => void;

export const cachedDnsLookup: DnsLookupFn = (hostname, options, callback) => {
    const now = Date.now();
    const cached = cache.get(hostname);
    if (cached && now < cached.expiresAt && cached.all === !!options.all) {
        if (options.all) {
            callback(null, cached.addresses.map((address) => ({ address, family: cached.family })));
        } else {
            callback(null, cached.addresses[0], cached.family);
        }
        return;
    }

    dns.lookup(hostname, options, (err, ...rest) => {
        if (!err) {
            const addresses = options.all
                ? (rest[0] as dns.LookupAddress[])
                : [{ address: rest[0] as string, family: rest[1] as number }];
            if (addresses.length > 0 && addresses[0].address) {
                evictExpired();
                cache.set(hostname, {
                    addresses: addresses.map((item) => item.address),
                    family: addresses[0].family ?? 4,
                    all: !!options.all,
                    expiresAt: now + CACHE_TTL_MS
                });
            }
        }
        callback(err, rest[0] as string | dns.LookupAddress[], rest[1] as number | undefined);
    });
};
