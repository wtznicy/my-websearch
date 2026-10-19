import net from 'node:net';

export async function probeTcpEndpoint(
    urlString: string,
    timeoutMs = 1000
): Promise<{
    reachable: boolean;
    host: string;
    port: number;
    latencyMs: number;
    error?: string;
} | null> {
    if (!urlString || !urlString.trim()) {
        return null;
    }

    let parsed: URL;
    try {
        parsed = new URL(urlString.trim());
    } catch {
        return null;
    }

    const host = parsed.hostname;
    const defaultPort = (parsed.protocol === 'https:' || parsed.protocol === 'wss:')
        ? 443
        : parsed.protocol.startsWith('socks')
            ? 1080
            : 80;
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
        return null;
    }

    const startedAt = Date.now();
    return await new Promise((resolve) => {
        let settled = false;
        const socket = net.createConnection({ host, port });

        const finish = (reachable: boolean, error?: string) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            resolve({
                reachable,
                host,
                port,
                latencyMs: Date.now() - startedAt,
                ...(error ? { error } : {})
            });
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false, `TCP connection timed out after ${timeoutMs}ms`));
        socket.once('error', (err) => finish(false, err.message));
    });
}
