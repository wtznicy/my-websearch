import net from 'node:net';
import dns from 'node:dns/promises';
import { getProxyUrl } from '../config.js';
import { requestDirectFirst, buildAxiosRequestOptions } from './httpRequest.js';

export interface InlineDiagnostics {
    proxy?: string;
    dns?: string;
    target?: string;
    suggestion?: string;
}

/**
 * 300ms TCP 探针：检测 host:port 是否可快速建立 TCP 握手
 */
export async function probeTcpConnect(host: string, port: number, timeoutMs = 300): Promise<boolean> {
    return new Promise((resolve) => {
        let resolved = false;
        const socket = new net.Socket();

        const cleanup = () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
            }
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => {
            cleanup();
            resolve(true);
        });
        socket.once('timeout', () => {
            cleanup();
            resolve(false);
        });
        socket.once('error', () => {
            cleanup();
            resolve(false);
        });

        try {
            socket.connect(port, host);
        } catch {
            cleanup();
            resolve(false);
        }
    });
}

/**
 * 快速内联诊断（仅在 outcome=failed 或网络类异常时触发，不阻塞正常请求链路）：
 * 300ms TCP 探针 + 1.5s HEAD 探针，输出高价值的 proxy / dns / suggestion 排障指引
 */
export async function runInlineDiagnostics(targetUrl?: string): Promise<InlineDiagnostics> {
    const diagnostics: InlineDiagnostics = {};
    const proxyUrlStr = getProxyUrl();

    let proxyHost: string | undefined;
    let proxyPort: number | undefined;
    if (proxyUrlStr) {
        try {
            const p = new URL(proxyUrlStr);
            proxyHost = p.hostname;
            proxyPort = Number(p.port) || (p.protocol === 'https:' ? 443 : 80);
        } catch {
            // ignore
        }
    }

    let targetHost: string | undefined;
    if (targetUrl) {
        try {
            targetHost = new URL(targetUrl).hostname;
        } catch {
            // ignore
        }
    }

    // 1. 代理端口 TCP 连通性探测 (300ms)
    let proxyTcpOk = false;
    if (proxyHost && proxyPort) {
        proxyTcpOk = await probeTcpConnect(proxyHost, proxyPort, 300);
        if (!proxyTcpOk) {
            diagnostics.proxy = `Proxy port ${proxyHost}:${proxyPort} is unreachable (TCP connection refused or timed out in 300ms).`;
            diagnostics.suggestion = '本地配置了代理但代理客户端未启动或端口不匹配，请启动 Clash/v2ray 并确认 PROXY_URL 端口。';
            return diagnostics;
        } else {
            diagnostics.proxy = `Proxy port ${proxyHost}:${proxyPort} reachable (TCP handshake ok).`;
        }
    }

    // 2. DNS 快速解析探测 (300ms)
    if (targetHost) {
        try {
            const lookupPromise = dns.lookup(targetHost);
            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('DNS timeout (300ms)')), 300)
            );
            await Promise.race([lookupPromise, timeoutPromise]);
            diagnostics.dns = `DNS lookup for ${targetHost} succeeded.`;
        } catch (dnsErr) {
            diagnostics.dns = `DNS lookup failed for ${targetHost}: ${dnsErr instanceof Error ? dnsErr.message : String(dnsErr)}`;
            diagnostics.suggestion = `目标域名 ${targetHost} 无法在本机 DNS 解析，请检查拼写或通过代理环境访问。`;
            return diagnostics;
        }
    }

    // 3. 1.5s 上游 HEAD 探针（检测代理端口可达但出口是否被上游风控/超时）
    const probeTarget = targetUrl || (proxyUrlStr ? 'https://www.google.com' : 'https://cn.bing.com');
    try {
        const headRes = await requestDirectFirst('HEAD', probeTarget, (forceDirect) => ({
            ...buildAxiosRequestOptions({ forceDirect, timeout: 1500 }),
            validateStatus: () => true
        }), 'Inline diagnostic HEAD probe');

        if (headRes.status === 429) {
            diagnostics.target = `Target returned HTTP 429 (Rate limited).`;
            diagnostics.suggestion = '上游服务触发了速率限制或风控，建议切换出口节点或稍后重试。';
        } else if (headRes.status === 403 || headRes.status === 202) {
            diagnostics.target = `Target returned HTTP ${headRes.status} (WAF / bot verification).`;
            diagnostics.suggestion = '出口 IP 可能被目标上游识别为数据中心/代理并拦截，建议更换干净节点或换用免翻国内引擎。';
        } else if (headRes.status >= 200 && headRes.status < 400) {
            diagnostics.target = `Target reachable via HTTP ${headRes.status}.`;
        }
    } catch (headErr) {
        const msg = headErr instanceof Error ? headErr.message : String(headErr);
        if (/timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(msg)) {
            if (proxyTcpOk) {
                diagnostics.suggestion = '代理端口可达但出口超时或被目标服务器拒连，属于出口 IP 被上游风控或代理节点无外网权限，非本地配置错误。';
            } else {
                diagnostics.suggestion = '网络连接异常或超时，目标站点可能需要海外代理或当前网络不可达。';
            }
        } else {
            diagnostics.suggestion = `目标站点访问失败 (${msg})，建议换用其他引擎或稍后重试。`;
        }
    }

    if (!diagnostics.suggestion) {
        diagnostics.suggestion = '请求异常，可检查目标 URL、确认代理配置或换用其他引擎重试。';
    }

    return diagnostics;
}
