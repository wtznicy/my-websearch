import CDP from 'chrome-remote-interface';
import { BrowserDriver, BrowserPage, BrowserSession, Cookie, LaunchOptions } from './driver.js';
import { LaunchedChrome, launchChromeProcess } from './chromeLauncher.js';
import { CDPPage } from './cdpPage.js';

interface CDPOptions {
    host?: string;
    port?: number;
    target?: string | ((targets: Array<{ id: string; type: string }>) => { id: string });
}

interface CDPStatic {
    (options?: CDPOptions): Promise<CDP.Client>;
    New(options?: CDPOptions & { url?: string }): Promise<{ id: string }>;
    List(options?: CDPOptions): Promise<Array<{ id: string; type: string; url: string }>>;
    Close(options?: CDPOptions & { id: string }): Promise<void>;
    Version(options?: CDPOptions): Promise<{ Browser?: string; 'User-Agent'?: string }>;
}

const cdp = CDP as unknown as CDPStatic;

export class CDPSession implements BrowserSession {
    private launched?: LaunchedChrome;
    private host: string;
    private port: number;
    private rootClient?: CDP.Client;
    private openPages: Set<BrowserPage> = new Set();
    private closed = false;

    constructor(options: { port: number; host?: string; launched?: LaunchedChrome }) {
        this.port = options.port;
        this.host = options.host || '127.0.0.1';
        this.launched = options.launched;
    }

    public async init(): Promise<void> {
        this.rootClient = await cdp({
            host: this.host,
            port: this.port
        });
    }

    public async newPage(): Promise<BrowserPage> {
        if (this.closed) {
            throw new Error('Cannot create new page: browser session is closed');
        }

        let targetId: string;
        try {
            const newTarget = await cdp.New({
                host: this.host,
                port: this.port,
                url: 'about:blank'
            });
            targetId = newTarget.id;
        } catch {
            if (!this.rootClient) {
                await this.init();
            }
            const res = await this.rootClient!.Target.createTarget({ url: 'about:blank' });
            targetId = res.targetId;
        }

        const pageClient = await cdp({
            host: this.host,
            port: this.port,
            target: targetId
        });

        const page = new CDPPage(pageClient, targetId);
        await page.init();
        this.openPages.add(page);

        return page;
    }

    public async version(): Promise<string> {
        try {
            const v = await cdp.Version({
                host: this.host,
                port: this.port
            });
            return v.Browser || 'Chrome/CDP';
        } catch {
            return 'Chrome/CDP';
        }
    }

    public contexts(): unknown[] {
        return [
            {
                newPage: () => this.newPage(),
                cookies: (urls?: string | string[]) => this.cookies(urls),
                close: async () => undefined,
                pages: () => Array.from(this.openPages)
            }
        ];
    }

    public async newContext(): Promise<unknown> {
        return {
            newPage: () => this.newPage(),
            cookies: (urls?: string | string[]) => this.cookies(urls),
            close: async () => undefined,
            pages: () => Array.from(this.openPages),
            clearCookies: async () => {
                try {
                    if (this.rootClient?.Network) {
                        await this.rootClient.Network.clearBrowserCookies();
                    }
                } catch {
                    // ignore
                }
            }
        };
    }

    public async cookies(urls?: string | string[]): Promise<Cookie[]> {
        if (!this.rootClient) {
            await this.init();
        }
        const urlList = Array.isArray(urls) ? urls : (urls ? [urls] : undefined);
        const res = await this.rootClient!.Network.getCookies(urlList ? { urls: urlList } : {});
        return (res.cookies || []).map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined
        }));
    }

    public isConnected(): boolean {
        return !this.closed;
    }

    public async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        activeCDPSessions.delete(this);

        for (const page of this.openPages) {
            try {
                await page.close();
            } catch {
                // ignore
            }
        }
        this.openPages.clear();

        if (this.rootClient) {
            try {
                await this.rootClient.close();
            } catch {
                // ignore
            }
        }

        if (this.launched) {
            await this.launched.cleanup();
        }
    }
}

const activeCDPSessions = new Set<CDPSession>();

export async function closeAllCDPSessions(): Promise<void> {
    const sessions = Array.from(activeCDPSessions);
    activeCDPSessions.clear();
    for (const session of sessions) {
        try {
            await session.close();
        } catch {
            // ignore
        }
    }
}

export class CDPDriver implements BrowserDriver {
    public async launch(options: LaunchOptions = {}): Promise<BrowserSession> {
        const launched = await launchChromeProcess(options);
        const session = new CDPSession({
            port: launched.port,
            host: '127.0.0.1',
            launched
        });
        activeCDPSessions.add(session);
        await session.init();
        return session;
    }

    public async connectOverCdp(endpoint: string, options?: { timeoutMs?: number }): Promise<BrowserSession> {
        let host = '127.0.0.1';
        let port = 9222;

        try {
            const parsed = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
            if (parsed.hostname) {
                host = parsed.hostname;
            }
            if (parsed.port) {
                port = Number.parseInt(parsed.port, 10);
            }
        } catch {
            // fallback to default
        }

        const session = new CDPSession({ host, port });
        activeCDPSessions.add(session);

        const timeoutMs = options?.timeoutMs ?? 30000;
        let timer: NodeJS.Timeout | undefined;

        try {
            await Promise.race([
                session.init(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        reject(new Error(`Connecting over CDP to ${endpoint} timed out after ${timeoutMs}ms`));
                    }, timeoutMs);
                })
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }

        return session;
    }
}

export const cdpDriver = new CDPDriver();
