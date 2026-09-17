import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Windows 系统根证书预取（供 curl-impersonate / curl-cffi-node 使用）。
 *
 * 背景：curl-impersonate 在 Windows 上找不到系统 CA 存储（无 /etc/ssl/certs 之类路径），
 * 首次请求会报 "curl error (60): SSL peer certificate" 并降级关闭 TLS 校验重试——
 * 多一次往返 + 静默关闭证书校验。这里在首次使用 impersonate 前，把 Windows 根证书
 * 导出为 PEM 文件并通过 CURL_CA_BUNDLE 指给 curl，让 TLS 校验始终开启。
 *
 * 失败（PowerShell 不可用/策略限制）时静默返回，由既有的降级路径兜底。
 */

const execFileAsync = promisify(execFile);

let ensurePromise: Promise<void> | null = null;

const CA_BUNDLE_PATH = path.join(os.tmpdir(), 'my-websearch-ca-bundle.pem');

async function exportWindowsRootCertificates(): Promise<string | null> {
    // 导出本机 + 当前用户根证书为 PEM（InsertLineBreaks 生成合法 PEM 行宽）
    const script = [
        "$ErrorActionPreference='Stop'",
        "Get-ChildItem -Path 'Cert:\\LocalMachine\\Root','Cert:\\CurrentUser\\Root' -ErrorAction SilentlyContinue | ForEach-Object { '-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks'); '-----END CERTIFICATE-----' }"
    ].join('; ');

    const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
    ], { maxBuffer: 32 * 1024 * 1024, timeout: 30000 });

    return stdout.includes('BEGIN CERTIFICATE') ? stdout : null;
}

/**
 * 确保 curl-impersonate 使用导出的 CA 包（仅 Windows；其他平台 curl 自带系统 CA）。
 * curl-cffi-node 的 native binding（OpenSSL 后端）读取 SSL_CERT_FILE 环境变量
 * （实测 CURL_CA_BUNDLE 被忽略）；两个都设置以兼容不同后端。
 * 幂等：进程内只执行一次；PEM 文件已存在则直接复用。
 */
export function ensureCurlCaBundle(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            try {
                if (process.platform !== 'win32' || process.env.SSL_CERT_FILE) {
                    return;
                }

                if (fs.existsSync(CA_BUNDLE_PATH) && fs.statSync(CA_BUNDLE_PATH).size > 0) {
                    process.env.SSL_CERT_FILE = CA_BUNDLE_PATH;
                    process.env.CURL_CA_BUNDLE = CA_BUNDLE_PATH;
                    return;
                }

                const pem = await exportWindowsRootCertificates();
                if (!pem) {
                    return;
                }

                fs.writeFileSync(CA_BUNDLE_PATH, pem, 'utf8');
                process.env.SSL_CERT_FILE = CA_BUNDLE_PATH;
                process.env.CURL_CA_BUNDLE = CA_BUNDLE_PATH;
                console.error(`🔐 Exported Windows root certificates for curl-impersonate: ${CA_BUNDLE_PATH}`);
            } catch (error) {
                console.warn('Failed to export Windows root certificates for curl-impersonate (TLS verification will retry without verification on curl 60):', error instanceof Error ? error.message : String(error));
            }
        })();
    }
    return ensurePromise;
}
