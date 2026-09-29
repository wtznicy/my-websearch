import { NativeFileLockHandle } from '../nativeInterop.js';

export type PlaywrightCookie = {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
};

export type PlaywrightLocatorLike = {
    first(): PlaywrightLocatorLike;
    isVisible(): Promise<boolean>;
    click(options?: { timeout?: number }): Promise<void>;
    press(key: string): Promise<void>;
    fill(value: string, options?: { timeout?: number }): Promise<void>;
    getAttribute(name: string): Promise<string | null>;
};

export type PlaywrightCDPSessionLike = {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type PlaywrightPageLike = {
    isClosed?(): boolean;
    context(): PlaywrightContextLike;
    goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number }): Promise<unknown>;
    waitForSelector(selector: string, options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<unknown>;
    waitForFunction(pageFunction: unknown, arg?: unknown, options?: { timeout?: number; polling?: number | 'raf' }): Promise<unknown>;
    waitForURL(urlOrPredicate: unknown, options?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }): Promise<unknown>;
    locator(selector: string): PlaywrightLocatorLike;
    keyboard: {
        press(key: string): Promise<void>;
        type(text: string): Promise<void>;
    };
    evaluate<T = unknown>(pageFunction: unknown, ...args: unknown[]): Promise<T>;
    url(): string;
    content(): Promise<string>;
    close?(): Promise<void>;
    addInitScript(script: () => void): Promise<void>;
    setViewportSize?(size: { width: number; height: number }): Promise<void>;
    setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
};

export type PlaywrightContextLike = {
    newPage(): Promise<PlaywrightPageLike>;
    pages?(): PlaywrightPageLike[];
    newCDPSession?(page: unknown): Promise<PlaywrightCDPSessionLike>;
    cookies(urls?: string | string[]): Promise<PlaywrightCookie[]>;
    close?(): Promise<void>;
};

export type PlaywrightBrowserLike = {
    version(): string | Promise<string>;
    close(): Promise<void>;
    disconnect?(): Promise<void> | void;
    contexts?(): PlaywrightContextLike[];
    newContext?(options?: Record<string, unknown>): Promise<PlaywrightContextLike>;
    newPage?(): Promise<PlaywrightPageLike>;
};

export type PlaywrightChromium = {
    launch(options?: Record<string, unknown>): Promise<PlaywrightBrowserLike>;
    connect(options: { wsEndpoint: string; timeout?: number; headers?: Record<string, string> }): Promise<PlaywrightBrowserLike>;
    connectOverCDP(endpoint: string, options?: Record<string, unknown>): Promise<PlaywrightBrowserLike>;
};

export type PlaywrightModule = {
    chromium: PlaywrightChromium;
};

export type PlaywrightBrowserSession = {
    browser: PlaywrightBrowserLike;
    /**
     * 释放当前调用方持有的浏览器句柄。WS/CDP 远程连接会断开连接；本地共享浏览器不会在这里关闭进程。
     * CLI/daemon 生命周期结束时应调用 shutdownLocalPlaywrightBrowserSessions() 统一销毁本地共享浏览器。
     */
    release(): Promise<void>;
};

export type PooledPlaywrightPageSession = {
    context: PlaywrightContextLike | null;
    page: PlaywrightPageLike;
    /** 将页面释放回进程内/跨进程页面池。 */
    releasePage(): Promise<void>;
};

export type OpenPlaywrightBrowserOptions = {
    hideWindow?: boolean;
};

export type AcquirePlaywrightPageOptions = {
    poolKey?: string;
    contextOptions?: Record<string, unknown>;
    preparePage?: (page: PlaywrightPageLike) => Promise<void>;
    preferExistingContext?: boolean;
};

export type LoadPlaywrightClientOptions = {
    silent?: boolean;
};

export type LocalBrowserSessionMode = 'headed' | 'headless' | 'hidden-headed';

export type LocalBrowserSession = {
    browser: PlaywrightBrowserLike;
    sessionKey: string;
    domainKey?: string;
    sessionMode: LocalBrowserSessionMode;
    browserPid?: number;
    debugPort?: number;
    tempDir?: string;
    closeBrowser(): Promise<void>;
    forceKill(): void;
};

export type LocalBrowserSessionMetadataFile = {
    browserPid?: number;
    debugPort?: number;
    tempDir: string;
    clientPids?: number[];
    savedAt?: number;
};

export type LocalBrowserSessionMetadata = {
    domainKey?: string;
    metadataPath?: string;
    sessionMode: LocalBrowserSessionMode;
    browserPid?: number;
    debugPort?: number;
    tempDir: string;
    clientPids: number[];
    savedAt?: number;
};

export type BrowserDomainMetadataEntry = {
    domainHash: string;
    sessionMode: LocalBrowserSessionMode;
    metadataPath: string;
};

export type LocalBrowserProcessCandidate = {
    pid: number;
    debugPort: number;
};

export type PooledPlaywrightPageEntry = {
    context: PlaywrightContextLike | null;
    page: PlaywrightPageLike;
    busy: boolean;
    prepared: boolean;
    pageTargetId: string;
    pageLock: NativeFileLockHandle | null;
};

export type BrowserPlaywrightPagePool = {
    poolKey: string;
    sharedContext: PlaywrightContextLike | null;
    entries: PooledPlaywrightPageEntry[];
    preparePage?: (page: PlaywrightPageLike) => Promise<void>;
    contextOptions?: Record<string, unknown>;
    preferExistingContext: boolean;
    acquireLock: Promise<void> | null;
};

export type ExistingContextPageWindowBounds = {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    windowState?: string;
};
