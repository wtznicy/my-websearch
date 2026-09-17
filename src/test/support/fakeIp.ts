import { lookup } from 'node:dns/promises';

/**
 * 检测系统 DNS 是否处于 TUN/fake-ip 代理环境（Clash TUN、Mihomo 等）。
 *
 * fake-ip 模式下 DNS 会把公网域名解析成保留段伪造 IP（198.18.0.0/15），
 * 依赖真实 DNS 行为的测试（nip.io 解析到私网、DNS 解析后的重定向拦截等）
 * 在该环境下失去验证意义——产品代码用 FAKE_IP_CIDRS 配置专门处理该环境。
 * 检测方法：解析稳定公网域名，若命中 fake-ip 保留段则判定为 TUN 环境。
 */
export async function isFakeIpDnsEnvironment(): Promise<boolean> {
    try {
        const addresses = await lookup('example.com', { all: true, verbatim: true });
        return addresses.some((entry) => entry.address.startsWith('198.18.') || entry.address.startsWith('198.19.'));
    } catch {
        return false;
    }
}
