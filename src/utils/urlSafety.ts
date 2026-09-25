import * as dns from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { config } from '../config.js';
import { metrics } from '../core/metrics.js';

/** SSRF 拦截审计（需 SECURITY_AUDIT=true）：此前 ssrf_blocked 事件类型零埋点 */
function reportBlocked(targetUrl: string | URL, reason: string): void {
    metrics.recordSecurityEvent({
        type: 'ssrf_blocked',
        targetUrl: typeof targetUrl === 'string' ? targetUrl : targetUrl.toString(),
        reason
    });
}

// URL.hostname preserves the brackets for IPv6 literals (`[::1]`), which
// break isIP and dns.lookup. Strip them once here.
function stripIpv6Brackets(host: string): string {
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

type LookupResult = Array<{ address: string }>;
type DnsLookupFn = (hostname: string) => Promise<LookupResult>;

let dnsLookupForSafety: DnsLookupFn = async (hostname) => {
    return dns.lookup(hostname, { all: true, verbatim: true });
};

/** 常见 fake-IP 网段（代理伪造）：命中但未被 fakeIpCidrs 覆盖时，错误信息里给出配置提示 */
const COMMON_FAKE_IP_HINTS: Array<{ cidr: string; example: string }> = [
    { cidr: '198.18.0.0/15', example: '198.18.0.0/15' },
    { cidr: '198.19.0.0/16', example: '198.19.0.0/16' },
    { cidr: '240.0.0.0/4', example: '240.0.0.0/4' }
];

/** 若被拦地址落在常见 fake-IP 段且不在配置中，附加可自愈的提示 */
export function hintFakeIpBlockedAddress(address: string): string {
    try {
        if (isIP(address) === 0) {
            return '';
        }
        const parsed = ipaddr.parse(address);
        for (const { cidr, example } of COMMON_FAKE_IP_HINTS) {
            if (parsed.match(ipaddr.parseCIDR(cidr))) {
                const configured = config.fakeIpCidrs.some((entry) => {
                    try {
                        return parsed.match(ipaddr.parseCIDR(entry));
                    } catch {
                        return false;
                    }
                });
                if (!configured) {
                    return ` | Hint: 该地址属于常见 fake-IP 网段（代理伪造）。若使用 Clash TUN/fake-ip 模式，请设置 FAKE_IP_CIDRS=${example}，搜索与抓取即可恢复`;
                }
                return '';
            }
        }
        return '';
    } catch {
        return '';
    }
}

function isAllowedFakeIp(address: string): boolean {
    if (isIP(address) === 0 || config.fakeIpCidrs.length === 0) {
        return false;
    }
    try {
        const parsed = ipaddr.parse(address);
        return config.fakeIpCidrs.some((cidr) => parsed.match(ipaddr.parseCIDR(cidr)));
    } catch {
        return false;
    }
}

export function __setDnsLookupForTests(lookup?: DnsLookupFn): void {
    dnsLookupForSafety = lookup ?? (async (hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
    const host = stripIpv6Brackets(hostname.trim().toLowerCase());
    if (!host || host === 'localhost' || host.endsWith('.localhost')) {
        return true;
    }
    if (isIP(host) === 0) {
        return false;
    }
    try {
        return ipaddr.parse(host).range() !== 'unicast';
    } catch {
        return false;
    }
}

// 0.0.0.0 及 0.0.0.0/8 段常被本地 DNS 屏蔽/污染时用作"黑洞地址"，
// 严格说不是私有网段，单独判定以便给出更准确的错误提示。
export function isBlackholeAddress(address: string): boolean {
    const host = stripIpv6Brackets(address.trim().toLowerCase());
    if (isIP(host) !== 4) {
        return false;
    }
    try {
        // 0.0.0.0/8 (RFC 1122: "This host on this network")
        return ipaddr.parse(host).match(ipaddr.parseCIDR('0.0.0.0/8'));
    } catch {
        return false;
    }
}

/**
 * DNS rebinding 类主机名：把内网地址藏进域名，本地/fake-ip 解析都看不出真相。
 *
 * 分两类处理：
 * ① 设计上就解析到回环的通配域名（localtest.me / lvh.me / vcap.me …）——一律拒绝；
 * ② 把 IP 编码进域名的通配服务（nip.io / sslip.io / xip.io / traefik.me）——**按嵌入的 IP 判定**：
 *    嵌入私网/保留地址才拒绝；`8.8.8.8.nip.io` 这类指向公网 IP 的写法保持可用
 *    （集成测试明确要求放行后者）。
 *
 * 为什么不能只看解析结果：① 实测 2026-09-25 用 `127.0.0.1.nip.io:18092` + USE_PROXY=true
 * 读出了本机服务内容；② Clash TUN/fake-ip 下这类域名解析成 198.18.x.x，看 IP 反而判不出来。
 */
const LOOPBACK_DNS_DOMAINS = [
    'localtest.me',
    'localtest.pro',
    'lvh.me',
    'vcap.me',
    'local.gd',
    'lacolhost.com'
];

const IP_ENCODING_DNS_SUFFIXES = [
    'nip.io',
    'sslip.io',
    'xip.io',
    'traefik.me'
];

/** host 等于 suffix 或为其子域时返回去掉 suffix 的前缀（无子域返回空串；不匹配返回 null） */
function matchDomainSuffix(host: string, suffix: string): string | null {
    if (host === suffix) {
        return '';
    }
    return host.endsWith(`.${suffix}`) ? host.slice(0, host.length - suffix.length - 1) : null;
}

/** 取出域名里编码的 IP：`127.0.0.1.nip.io` / `127-0-0-1.sslip.io` / `10.0.0.1.traefik.me` */
function embeddedAddress(host: string): string | null {
    for (const suffix of IP_ENCODING_DNS_SUFFIXES) {
        const prefix = matchDomainSuffix(host, suffix);
        if (prefix === null || prefix === '') {
            continue;
        }
        // sslip.io 支持用连字符代替点（127-0-0-1）；多段子域（如 a.b.nip.io）解析不出 IP，交给 DNS 判定
        const candidate = prefix.replace(/-/g, '.');
        return isIP(candidate) !== 0 ? candidate : null;
    }
    return null;
}

/** 主机名是否为"解析到内网"的重绑定类服务（含其子域） */
export function isRebindingStyleHostname(hostname: string): boolean {
    const host = stripIpv6Brackets(hostname.trim().toLowerCase()).replace(/\.$/, '');
    if (!host) {
        return false;
    }
    if (LOOPBACK_DNS_DOMAINS.some((domain) => matchDomainSuffix(host, domain) !== null)) {
        return true;
    }
    const address = embeddedAddress(host);
    return address !== null && isPrivateOrLocalHostname(address);
}

export function isPublicHttpUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return false;
        }
        if (isRebindingStyleHostname(parsed.hostname)) {
            return false;
        }
        return !isPrivateOrLocalHostname(parsed.hostname);
    } catch {
        return false;
    }
}

export function assertPublicHttpUrl(url: string | URL, label: string = 'URL'): void {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label} must use HTTP or HTTPS`);
    }
    if (isRebindingStyleHostname(parsed.hostname)) {
        reportBlocked(parsed, `${label} uses a wildcard DNS service (DNS rebinding)`);
        throw new Error(`${label} uses a wildcard DNS service that can point at private addresses (DNS rebinding), which is not allowed`);
    }
    if (isPrivateOrLocalHostname(parsed.hostname)) {
        reportBlocked(parsed, `${label} points to a private or local network target`);
        throw new Error(`${label} points to a private or local network target, which is not allowed`);
    }
}

// DNS-resolves hostnames and rejects private answers. Needed for proxy mode,
// where request-filtering-agent isn't in the chain.
export async function assertPublicHttpUrlResolved(url: string | URL, label: string = 'URL'): Promise<void> {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    assertPublicHttpUrl(parsed, label);

    const host = stripIpv6Brackets(parsed.hostname);
    if (isIP(host) !== 0) {
        // 字面量 IP 直接做黑/私网检查；若命中黑洞地址给出专属提示
        if (isBlackholeAddress(host)) {
            throw new Error(`${label} points to 0.0.0.0/8 (blackhole), which is usually caused by local DNS blocking/pollution — check DNS or enable a proxy`);
        }
        return;
    }

    let resolved: LookupResult;
    try {
        resolved = await dnsLookupForSafety(host);
    } catch {
        throw new Error(`${label} could not be resolved`);
    }
    const blackholeHit = resolved.find((entry) => isBlackholeAddress(entry.address));
    if (blackholeHit) {
        // 0.0.0.0/8 是"本地 DNS 屏蔽/污染"的信号，不是安全信号（原始设计意图）：
        // 代理模式下请求由代理远端解析，本地污染不应导致误拦，交给代理处理
        if (config.useProxy) {
            return;
        }
        throw new Error(`${label} resolves to ${blackholeHit.address} (0.0.0.0/8 blackhole) — likely local DNS blocking/pollution; check DNS or enable a proxy`);
    }

    // 代理模式同样做本地解析判定（此前这里直接 return，导致 USE_PROXY=true 时
    // "解析到内网"的域名完全不设防——实测可读出本机服务内容）。
    // 本地答案虽然不是代理的实际连接依据，但攻击者用的正是"在公网 DNS 上就解析到内网"的域名，
    // 本地解析能识别出来；fake-ip（Clash TUN 等代理伪造段）仍按配置放行，否则会误杀 TUN 用户的正常抓取。
    const blockedEntry = resolved.find((entry) => isPrivateOrLocalHostname(entry.address) && !isAllowedFakeIp(entry.address));
    if (blockedEntry) {
        reportBlocked(parsed, `${label} resolves to ${blockedEntry.address} (private or local)`);
        throw new Error(`${label} resolves to a private or local network target, which is not allowed${hintFakeIpBlockedAddress(blockedEntry.address)}`);
    }
}
