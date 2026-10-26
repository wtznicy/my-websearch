import type { Client } from 'chrome-remote-interface';
import { BrowserKeyboard, BrowserLocator, BrowserPage, Cookie, LocatorOptions } from './driver.js';

export class CDPPage implements BrowserPage {
    private client: Client;
    public readonly targetId: string;
    private currentUrl = 'about:blank';
    private closed = false;
    private inFlightRequests = 0;
    private lastRequestTime = Date.now();

    public keyboard: BrowserKeyboard;

    constructor(client: Client, targetId: string) {
        this.client = client;
        this.targetId = targetId;

        this.keyboard = {
            press: async (key: string) => this.handleKeyboardPress(key),
            type: async (text: string) => this.handleKeyboardType(text)
        };

        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        const { Page, Network } = this.client;

        Page.frameNavigated((params: { frame: { url: string; parentId?: string } }) => {
            if (!params.frame.parentId) {
                this.currentUrl = params.frame.url;
            }
        });

        Network.requestWillBeSent(() => {
            this.inFlightRequests += 1;
            this.lastRequestTime = Date.now();
        });

        Network.loadingFinished(() => {
            this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
            this.lastRequestTime = Date.now();
        });

        Network.loadingFailed(() => {
            this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
            this.lastRequestTime = Date.now();
        });
    }

    public async init(): Promise<void> {
        const { Page, Runtime, Network } = this.client;
        await Promise.all([
            Page.enable(),
            Runtime.enable(),
            Network.enable()
        ]);
    }

    public url(): string {
        return this.currentUrl;
    }

    public async title(): Promise<string> {
        return this.evaluate<string>('document.title').catch(() => '');
    }

    public async goto(
        url: string,
        options?: { timeoutMs?: number; timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
    ): Promise<{ status: number; url: string }> {
        const timeoutMs = options?.timeoutMs ?? options?.timeout ?? 30000;
        const waitUntil = options?.waitUntil ?? 'load';
        const { Page } = this.client;

        let timer: NodeJS.Timeout | undefined;
        let unsubscribe: (() => void) | undefined;

        const waitPromise = new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Navigation to ${url} timed out after ${timeoutMs}ms (waitUntil: ${waitUntil})`));
            }, timeoutMs);

            if (waitUntil === 'domcontentloaded') {
                const handler = () => {
                    resolve();
                };
                Page.domContentEventFired(handler);
                unsubscribe = () => { /* event listener cleanup */ };
            } else if (waitUntil === 'networkidle') {
                const interval = setInterval(() => {
                    if (this.inFlightRequests === 0 && Date.now() - this.lastRequestTime >= 500) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 100);
                unsubscribe = () => clearInterval(interval);
            } else {
                const handler = () => {
                    resolve();
                };
                Page.loadEventFired(handler);
                unsubscribe = () => { /* event listener cleanup */ };
            }
        });

        try {
            const navResult = await Page.navigate({ url });
            if (navResult.errorText) {
                throw new Error(`Navigation to ${url} failed: ${navResult.errorText}`);
            }
            this.currentUrl = url;
            await waitPromise;
            return { status: 200, url: this.currentUrl };
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
            if (unsubscribe) {
                unsubscribe();
            }
        }
    }

    public async content(): Promise<string> {
        return this.evaluate<string>('document.documentElement.outerHTML').catch(() => '');
    }

    public isClosed(): boolean {
        return this.closed;
    }

    public async evaluate<T>(
        expressionOrFn: string | ((...args: unknown[]) => unknown),
        ...args: unknown[]
    ): Promise<T> {
        const { Runtime } = this.client;
        let expression: string;

        if (typeof expressionOrFn === 'string') {
            expression = expressionOrFn;
        } else {
            const serializedArgs = args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ');
            expression = `(${expressionOrFn.toString()})(${serializedArgs})`;
        }

        const res = await Runtime.evaluate({
            expression,
            awaitPromise: true,
            returnByValue: true
        });

        if (res.exceptionDetails) {
            const desc = res.exceptionDetails.exception?.description
                || res.exceptionDetails.text
                || 'Evaluation exception in browser';
            throw new Error(desc);
        }

        return res.result.value as T;
    }

    public async waitForSelector(
        selector: string,
        timeoutMsOrOptions?: number | { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }
    ): Promise<void> {
        const timeoutMs = typeof timeoutMsOrOptions === 'number'
            ? timeoutMsOrOptions
            : (timeoutMsOrOptions?.timeout ?? 30000);
        const state = typeof timeoutMsOrOptions === 'object' && timeoutMsOrOptions?.state
            ? timeoutMsOrOptions.state
            : 'visible';

        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const matched = await this.evaluate<boolean>(`(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return ${state === 'detached' || state === 'hidden'};
                if ('${state}' === 'attached') return true;
                if ('${state}' === 'detached') return false;
                const rects = el.getClientRects();
                const style = window.getComputedStyle(el);
                const isVisible = rects.length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                return '${state}' === 'visible' ? isVisible : !isVisible;
            })()`).catch(() => false);

            if (matched) {
                return;
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        throw new Error(`waitForSelector("${selector}") timed out after ${timeoutMs}ms (state: ${state})`);
    }

    public async waitForFunction(
        pageFunction: unknown,
        arg?: unknown,
        options?: { timeout?: number }
    ): Promise<unknown> {
        const timeoutMs = options?.timeout ?? 30000;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            try {
                let res: unknown;
                if (typeof pageFunction === 'string') {
                    res = await this.evaluate(pageFunction);
                } else if (typeof pageFunction === 'function') {
                    res = await this.evaluate(pageFunction as (...a: unknown[]) => unknown, arg);
                }
                if (res) {
                    return res;
                }
            } catch {
                // retry
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        throw new Error(`waitForFunction timed out after ${timeoutMs}ms`);
    }

    public async waitForURL(
        urlOrPredicate: unknown,
        options?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
    ): Promise<unknown> {
        const timeoutMs = options?.timeout ?? 30000;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const current = this.url();
            let match = false;

            if (typeof urlOrPredicate === 'string') {
                match = current.includes(urlOrPredicate);
            } else if (urlOrPredicate instanceof RegExp) {
                match = urlOrPredicate.test(current);
            } else if (typeof urlOrPredicate === 'function') {
                try {
                    match = Boolean((urlOrPredicate as (u: URL) => boolean)(new URL(current)));
                } catch {
                    match = false;
                }
            }

            if (match) {
                return current;
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        throw new Error(`waitForURL timed out after ${timeoutMs}ms waiting for match with current URL: ${this.url()}`);
    }

    public async waitForTimeout(ms: number): Promise<void> {
        await new Promise((r) => setTimeout(r, ms));
    }

    public async waitForLoadState(
        state: 'load' | 'domcontentloaded' | 'networkidle' = 'load',
        options?: { timeout?: number }
    ): Promise<void> {
        const timeoutMs = options?.timeout ?? 15000;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            if (state === 'domcontentloaded') {
                const ready = await this.evaluate<boolean>('document.readyState !== "loading"').catch(() => false);
                if (ready) return;
            } else if (state === 'load') {
                const complete = await this.evaluate<boolean>('document.readyState === "complete"').catch(() => false);
                if (complete) return;
            } else if (state === 'networkidle') {
                if (this.inFlightRequests === 0 && Date.now() - this.lastRequestTime >= 500) {
                    return;
                }
            }
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    public async click(selector: string, options?: LocatorOptions): Promise<void> {
        const timeoutMs = options?.timeout ?? 10000;
        await this.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });

        const clicked = await this.evaluate<boolean>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el instanceof HTMLElement) {
                el.scrollIntoView?.({ block: 'center', inline: 'center' });
                el.click();
                return true;
            }
            return false;
        })()`);

        if (!clicked) {
            throw new Error(`Failed to click on selector "${selector}": element not found or not clickable`);
        }
    }

    public async fill(selector: string, value: string, options?: LocatorOptions): Promise<void> {
        const timeoutMs = options?.timeout ?? 10000;
        await this.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });

        const filled = await this.evaluate<boolean>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                el.focus();
                el.value = ${JSON.stringify(value)};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
            return false;
        })()`);

        if (!filled) {
            throw new Error(`Failed to fill selector "${selector}": element is not an input or textarea`);
        }
    }

    public locator(selector: string): BrowserLocator {
        const page = this;
        return {
            first(): BrowserLocator {
                return this;
            },
            async isVisible(): Promise<boolean> {
                return page.evaluate<boolean>(`(() => {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (!el) return false;
                    const rects = el.getClientRects();
                    const style = window.getComputedStyle(el);
                    return rects.length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                })()`).catch(() => false);
            },
            async click(options?: LocatorOptions): Promise<void> {
                return page.click(selector, options);
            },
            async press(key: string): Promise<void> {
                await page.evaluate(`(() => {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (el instanceof HTMLElement) el.focus();
                })()`).catch(() => undefined);
                return page.keyboard.press(key);
            },
            async fill(value: string, options?: LocatorOptions): Promise<void> {
                return page.fill(selector, value, options);
            },
            async getAttribute(name: string): Promise<string | null> {
                return page.evaluate<string | null>(`(() => {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    return el ? el.getAttribute(${JSON.stringify(name)}) : null;
                })()`).catch(() => null);
            }
        };
    }

    public async cookies(urls?: string | string[]): Promise<Cookie[]> {
        const { Network } = this.client;
        const urlList = Array.isArray(urls) ? urls : (urls ? [urls] : undefined);
        const res = await Network.getCookies(urlList ? { urls: urlList } : {});
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

    public async setViewport(width: number, height: number): Promise<void> {
        const { Emulation } = this.client;
        await Emulation.setDeviceMetricsOverride({
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false
        });
    }

    public async setViewportSize(size: { width: number; height: number }): Promise<void> {
        return this.setViewport(size.width, size.height);
    }

    public async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
        const { Network } = this.client;
        await Network.setExtraHTTPHeaders({ headers });
    }

    public async addInitScript(script: string | (() => void)): Promise<void> {
        const { Page } = this.client;
        const source = typeof script === 'function' ? `(${script.toString()})()` : script;
        await Page.addScriptToEvaluateOnNewDocument({ source });
    }

    public context(): {
        cookies(urls?: string | string[]): Promise<Cookie[]>;
        newPage(): Promise<BrowserPage>;
        close(): Promise<void>;
        newCDPSession?: (page?: unknown) => Promise<{ send(method: string, params?: Record<string, unknown>): Promise<unknown> }>;
    } {
        const page = this;
        return {
            cookies: (urls) => page.cookies(urls),
            newPage: () => Promise.reject(new Error('Creating a page from page.context() is not supported on single-target CDPPage')),
            close: () => page.close(),
            newCDPSession: async () => ({
                send: async (method: string, params?: Record<string, unknown>) => {
                    const [domain, cmd] = method.split('.');
                    const clientRecord = this.client as unknown as Record<string, Record<string, (p?: unknown) => Promise<unknown>>>;
                    const domainObj = domain ? clientRecord[domain] : undefined;
                    if (domainObj && cmd && typeof domainObj[cmd] === 'function') {
                        return domainObj[cmd](params);
                    }
                    return Promise.resolve({});
                }
            })
        };
    }

    private async handleKeyboardPress(key: string): Promise<void> {
        const { Input } = this.client;
        if (key === 'Enter') {
            await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
            await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        } else if (key === 'Backspace') {
            await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        } else if (key.includes('Control+A') || key.includes('Meta+A')) {
            await this.evaluate('document.execCommand("selectAll")').catch(() => undefined);
        } else {
            await Input.dispatchKeyEvent({ type: 'rawKeyDown', key, text: key });
            await Input.dispatchKeyEvent({ type: 'keyUp', key });
        }
    }

    private async handleKeyboardType(text: string): Promise<void> {
        const { Input } = this.client;
        await Input.insertText({ text });
    }

    public async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        try {
            const { Target } = this.client;
            if (this.targetId) {
                await Target.closeTarget({ targetId: this.targetId }).catch(() => undefined);
            }
        } finally {
            await this.client.close().catch(() => undefined);
        }
    }
}
