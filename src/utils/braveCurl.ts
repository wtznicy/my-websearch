import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CurlResponse {
    status: number;
    data: string;
}

/**
 * Windows curl uses Schannel for TLS. In the current Brave/CloudFront tests
 * this survives far longer than Node's OpenSSL axios stack (7/10 vs 0/10),
 * while .NET Schannel HTTP/2 did not rescue a curl 429 (0/3 same URL, 0/3
 * fresh URL). Keep this as the primary no-key web path on Windows.
 */
export async function braveHttpGetWithCurl(
    url: string,
    proxyUrl: string | undefined,
    headers: Record<string, string>,
    signal?: AbortSignal
): Promise<CurlResponse | null> {
    if (process.platform !== 'win32' || process.env.BRAVE_CURL === '0') {
        return null;
    }

    const tempFile = path.join(
        os.tmpdir(),
        `mywebsearch-brave-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`
    );
    const args = [
        '-sS',
        '--http1.1',
        '--compressed',
        '--max-time', '20',
        '--connect-timeout', '10',
        '-o', tempFile,
        '-w', '%{http_code}'
    ];
    if (proxyUrl) args.push('--proxy', proxyUrl);

    const userAgent = headers['User-Agent'] ?? headers['user-agent'];
    if (userAgent) args.push('-A', userAgent);
    for (const [key, value] of Object.entries(headers)) {
        if (!value || key.toLowerCase() === 'user-agent' || key.toLowerCase() === 'accept-encoding') continue;
        args.push('-H', `${key}: ${value}`);
    }
    args.push(url);

    try {
        const { stdout } = await execFileAsync('curl.exe', args, {
            timeout: 25_000,
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true,
            signal
        });
        const status = Number.parseInt(stdout.trim(), 10);
        if (!Number.isFinite(status)) return null;
        const data = await fs.readFile(tempFile, 'utf8');
        return { status, data };
    } catch {
        return null;
    } finally {
        await fs.unlink(tempFile).catch(() => undefined);
    }
}
