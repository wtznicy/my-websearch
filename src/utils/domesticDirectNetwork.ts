import os from 'node:os';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { config } from '../config.js';

interface PhysicalCandidate {
    name: string;
    address: string;
    isPhysicalName: boolean;
}

const VIRTUAL_ADAPTER_REGEX = /(meta|tun|tap|wsl|loopback|docker|vmnet|vmware|virtualbox|veth|tailscale|wireguard|zerotier|clash|sing-box)/i;
const PHYSICAL_ADAPTER_REGEX = /(wlan|wi-fi|wifi|ethernet|eth|en\d|以太网|本地连接)/i;

/** 国内主流知名服务商及 .cn 域名后缀 */
const DOMESTIC_DOMAIN_REGEX = /(^|\.)(csdn\.net|juejin\.cn|baidu\.com|sogou\.com|bilibili\.com|zhihu\.com|qq\.com|163\.com|aliyun\.com)$/i;

let cachedPhysicalIp: string | null = null;
let physicalIpCachedAt = 0;
const PHYSICAL_IP_CACHE_TTL_MS = 15000;

/**
 * 获取本机真实的物理网络接口 IPv4 地址（排除 TUN/TAP、VMware、Docker 等虚拟网卡）。
 * 带有 15 秒缓存，网络切换时能自愈。
 */
export function getPhysicalInterfaceIpv4(overrideInterfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
    const now = Date.now();
    if (!overrideInterfaces && cachedPhysicalIp && (now - physicalIpCachedAt < PHYSICAL_IP_CACHE_TTL_MS)) {
        return cachedPhysicalIp;
    }

    const nets = overrideInterfaces || os.networkInterfaces();
    const candidates: PhysicalCandidate[] = [];

    for (const [name, interfaces] of Object.entries(nets)) {
        if (!interfaces || VIRTUAL_ADAPTER_REGEX.test(name)) {
            continue;
        }

        for (const iface of interfaces) {
            if (iface.internal || iface.family !== 'IPv4') {
                continue;
            }

            const addr = iface.address;
            // 排除 127.0.0.1、198.18.0.0/15 (Clash TUN Fake-IP)、240.0.0.0/4 等合成网段
            if (addr.startsWith('127.') || addr.startsWith('198.18.') || addr.startsWith('198.19.') || addr.startsWith('240.')) {
                continue;
            }

            // 检查配置的 Fake-IP CIDR
            let isFakeIp = false;
            try {
                const parsed = ipaddr.parse(addr);
                if (parsed.range() === 'loopback') {
                    continue;
                }
                for (const cidr of config.fakeIpCidrs) {
                    if (parsed.match(ipaddr.parseCIDR(cidr))) {
                        isFakeIp = true;
                        break;
                    }
                }
            } catch {
                continue;
            }

            if (isFakeIp) {
                continue;
            }

            candidates.push({
                name,
                address: addr,
                isPhysicalName: PHYSICAL_ADAPTER_REGEX.test(name)
            });
        }
    }

    if (candidates.length === 0) {
        if (!overrideInterfaces) {
            cachedPhysicalIp = null;
            physicalIpCachedAt = now;
        }
        return null;
    }

    // 优先按网卡命名匹配（WLAN, Ethernet 等），其次按枚举顺序
    candidates.sort((a, b) => (b.isPhysicalName ? 1 : 0) - (a.isPhysicalName ? 1 : 0));
    const selected = candidates[0]?.address ?? null;

    if (!overrideInterfaces) {
        cachedPhysicalIp = selected;
        physicalIpCachedAt = now;
    }

    return selected;
}

interface DnsCacheEntry {
    ip: string;
    expiresAt: number;
}

const dohIpCache = new Map<string, DnsCacheEntry>();
const DOH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

interface DohAnswer {
    name?: string;
    type?: number;
    data?: string;
    TTL?: number;
}

interface DohResponse {
    Status?: number;
    Answer?: DohAnswer[];
}

/**
 * 通过公共 DoH（阿里云 DNS / 腾讯 DNSPod）绕过 Fake-IP / TUN 本地劫持，解析国内主机的真实公网 IPv4。
 */
export async function resolveRealDomesticHostIp(
    hostname: string,
    dohFetchImpl?: (url: string) => Promise<DohResponse | null>
): Promise<string | null> {
    const cleanHost = hostname.trim().toLowerCase();
    if (!cleanHost || isIP(cleanHost) !== 0) {
        return null;
    }

    const now = Date.now();
    const cached = dohIpCache.get(cleanHost);
    if (cached && cached.expiresAt > now) {
        return cached.ip;
    }

    const dohUrls = [
        `https://dns.alidns.com/resolve?name=${encodeURIComponent(cleanHost)}&type=A`,
        `https://doh.pub/resolve?name=${encodeURIComponent(cleanHost)}&type=A`
    ];

    for (const dohUrl of dohUrls) {
        try {
            let data: DohResponse | null = null;
            if (dohFetchImpl) {
                data = await dohFetchImpl(dohUrl);
            } else {
                const response = await fetch(dohUrl, { signal: AbortSignal.timeout(3000) });
                if (response.ok) {
                    data = (await response.json()) as DohResponse;
                }
            }

            if (!data || !Array.isArray(data.Answer)) {
                continue;
            }

            for (const ans of data.Answer) {
                // type 1 为 A 记录
                if (ans.type === 1 && typeof ans.data === 'string' && isIP(ans.data) === 4) {
                    const resolvedIp = ans.data;
                    // SSRF 安全校验：解析出来的必须是公网单播 IP，严禁私网或保留段
                    try {
                        const parsed = ipaddr.parse(resolvedIp);
                        if (parsed.range() !== 'unicast') {
                            continue;
                        }
                        if (resolvedIp.startsWith('198.18.') || resolvedIp.startsWith('198.19.') || resolvedIp.startsWith('240.')) {
                            continue;
                        }
                    } catch {
                        continue;
                    }

                    dohIpCache.set(cleanHost, {
                        ip: resolvedIp,
                        expiresAt: now + DOH_CACHE_TTL_MS
                    });
                    return resolvedIp;
                }
            }
        } catch {
            // 单个 DoH 失败尝试下一个
            continue;
        }
    }

    return null;
}

/**
 * 判断目标是否为国内站点（通过知名域名表或 .cn 域名后缀判断）
 */
export function isDomesticHostname(hostname: string): boolean {
    const host = hostname.trim().toLowerCase();
    if (!host) {
        return false;
    }
    return host.endsWith('.cn') || DOMESTIC_DOMAIN_REGEX.test(host);
}

/**
 * 判断错误是否为 TLS 握手被 WAF 重置、连接被切断或 HTTP 521
 */
export function isTlsOrWafResetError(error: unknown): boolean {
    if (!error) {
        return false;
    }

    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 521 || status === 522) {
        return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code;

    if (code && /ECONNRESET|ECONNABORTED|EPROTO|ERR_SSL/i.test(code)) {
        return true;
    }

    return /ECONNRESET|socket disconnected before secure TLS|unexpected EOF|socket hang up|renegotiation|Client network socket disconnected|SSL routines/i.test(message);
}

/**
 * 综合判定：是否应该尝试物理网卡直连补偿兜底
 */
export function shouldAttemptDomesticDirectRetry(error: unknown, hostname: string): boolean {
    if (!isDomesticHostname(hostname)) {
        return false;
    }
    if (!isTlsOrWafResetError(error)) {
        return false;
    }
    const physicalIp = getPhysicalInterfaceIpv4();
    return Boolean(physicalIp);
}

/**
 * 为指定国内主机创建绑定物理网卡与真实公网 IP 的 direct https.Agent。
 * 若无法检测物理网卡或解析真实 IP，返回 null。
 */
export async function createDomesticDirectAgent(
    hostname: string,
    dohFetchImpl?: (url: string) => Promise<DohResponse | null>
): Promise<https.Agent | null> {
    const physicalIp = getPhysicalInterfaceIpv4();
    if (!physicalIp) {
        return null;
    }

    const realIp = await resolveRealDomesticHostIp(hostname, dohFetchImpl);
    if (!realIp) {
        return null;
    }

    return new https.Agent({
        keepAlive: true,
        maxSockets: 16,
        localAddress: physicalIp,
        lookup: (_h, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            if (typeof cb === 'function') {
                cb(null, realIp, 4);
            }
        }
    });
}

/** 仅供单测清空状态 */
export function clearDomesticNetworkCache(): void {
    cachedPhysicalIp = null;
    physicalIpCachedAt = 0;
    dohIpCache.clear();
}
