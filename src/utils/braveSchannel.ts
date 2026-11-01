import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SchannelResponse {
    status: number;
    data: string;
}

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$proxy = $env:BRAVE_SCHANNEL_PROXY
if ($proxy) {
  $handler.Proxy = [System.Net.WebProxy]::new($proxy)
  $handler.UseProxy = $true
}
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(20)
$request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $env:BRAVE_SCHANNEL_URL)
$request.Version = [Version]'2.0'
$request.VersionPolicy = [System.Net.Http.HttpVersionPolicy]::RequestVersionExact
$request.Headers.UserAgent.ParseAdd($env:BRAVE_SCHANNEL_UA)
$request.Headers.AcceptLanguage.ParseAdd('zh-CN,zh;q=0.9,en;q=0.8')
$response = $client.SendAsync($request).GetAwaiter().GetResult()
$body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
$result = @{ status = [int]$response.StatusCode; body = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body)) }
$result | ConvertTo-Json -Compress
$client.Dispose()
`.trim();

function getPowerShellCommand(): string {
    return process.env.BRAVE_SCHANNEL_POWERSHELL || (process.platform === 'win32' ? 'pwsh' : '');
}

/**
 * Windows-only Brave web fallback.
 *
 * Node's OpenSSL HTTP/1.1 stack and wreq's HTTP/2 fingerprint both get 429
 * from Brave's CloudFront. Windows Schannel over HTTP/2 currently gets 200 in
 * manual tests, so this is used only after the normal axios request is 429.
 */
export async function braveHttpGetWithSchannel(
    url: string,
    proxyUrl?: string,
    userAgent?: string
): Promise<SchannelResponse | null> {
    if (process.platform !== 'win32' || process.env.BRAVE_SCHANNEL_FALLBACK === '0') {
        return null;
    }
    const command = getPowerShellCommand();
    if (!command) return null;

    const env = {
        ...process.env,
        BRAVE_SCHANNEL_URL: url,
        BRAVE_SCHANNEL_PROXY: proxyUrl ?? '',
        BRAVE_SCHANNEL_UA: userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
    };

    for (const executable of [command, command === 'pwsh' ? 'powershell.exe' : '']) {
        if (!executable) continue;
        try {
            const { stdout } = await execFileAsync(
                executable,
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
                { env, timeout: 25_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }
            );
            const parsed = JSON.parse(stdout.trim()) as { status?: number; body?: string };
            if (typeof parsed.status !== 'number' || typeof parsed.body !== 'string') continue;
            return {
                status: parsed.status,
                data: Buffer.from(parsed.body, 'base64').toString('utf8')
            };
        } catch {
            // Try the next PowerShell executable.
        }
    }
    return null;
}
