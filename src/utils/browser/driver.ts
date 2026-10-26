/**
 * 统一浏览器驱动抽象接口（Browser Driver Abstraction）。
 *
 * 用于解耦具体驱动实现（CDP / 原生 Chrome vs 历史 Playwright），
 * 提供轻量统一的页面控制、导航、求值与 Cookie 接口。
 */

export interface LaunchOptions {
    headless?: boolean;
    executablePath?: string;
    args?: string[];
    proxy?: {
        server: string;
        bypass?: string;
    };
    userDataDir?: string;
    timeoutMs?: number;
}

export interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface LocatorOptions {
    timeout?: number;
}

export interface BrowserLocator {
    first(): BrowserLocator;
    isVisible(): Promise<boolean>;
    click(options?: LocatorOptions): Promise<void>;
    press(key: string): Promise<void>;
    fill(value: string, options?: LocatorOptions): Promise<void>;
    getAttribute(name: string): Promise<string | null>;
}

export interface BrowserKeyboard {
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
}

export interface BrowserPage {
    goto(url: string, options?: { timeoutMs?: number; timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<{ status: number; url: string }>;
    waitForSelector(selector: string, timeoutMsOrOptions?: number | { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<void>;
    evaluate<T>(expressionOrFn: string | ((...args: unknown[]) => unknown), ...args: unknown[]): Promise<T>;
    content(): Promise<string>;
    click(selector: string, options?: LocatorOptions): Promise<void>;
    fill(selector: string, value: string, options?: LocatorOptions): Promise<void>;
    cookies(urls?: string | string[]): Promise<Cookie[]>;
    setViewport(width: number, height: number): Promise<void>;
    close(): Promise<void>;

    // 引擎向后兼容接口
    url(): string;
    title(): Promise<string>;
    waitForFunction(pageFunction: unknown, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
    waitForURL(urlOrPredicate: unknown, options?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<unknown>;
    waitForTimeout(ms: number): Promise<void>;
    waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options?: { timeout?: number }): Promise<void>;
    locator(selector: string): BrowserLocator;
    keyboard: BrowserKeyboard;
    context(): {
        cookies(urls?: string | string[]): Promise<Cookie[]>;
        newPage(): Promise<BrowserPage>;
        close(): Promise<void>;
    };
    addInitScript(script: string | (() => void)): Promise<void>;
    setViewportSize(size: { width: number; height: number }): Promise<void>;
    setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
    route?(pattern: string, handler: (route: unknown) => Promise<void>): Promise<void>;
}

export interface BrowserSession {
    newPage(): Promise<BrowserPage>;
    close(): Promise<void>;
    version?(): Promise<string> | string;
    contexts?(): unknown[];
    isConnected?(): boolean;
}

export interface BrowserDriver {
    launch(options?: LaunchOptions): Promise<BrowserSession>;
    connectOverCdp(endpoint: string, options?: { timeoutMs?: number }): Promise<BrowserSession>;
}
