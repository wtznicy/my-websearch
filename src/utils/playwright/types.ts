import { NativeFileLockHandle } from '../nativeInterop.js';

export type PlaywrightChromium = {
    launch(options?: any): Promise<any>;
    connect(options: { wsEndpoint: string; timeout?: number; headers?: Record<string, string> }): Promise<any>;
    connectOverCDP(endpoint: string, options?: any): Promise<any>;
};

export type PlaywrightModule = {
    chromium: PlaywrightChromium;
};

export type PlaywrightBrowserSession = {
    browser: any;
    /**
     * 释放当前调用方持有的浏览器句柄。WS/CDP 远程连接会断开连接；本地共享浏览器不会在这里关闭进程。
     * CLI/daemon 生命周期结束时应调用 shutdownLocalPlaywrightBrowserSessions() 统一销毁本地共享浏览器。
     */
    release(): Promise<void>;
};

export type PooledPlaywrightPageSession = {
    context: any | null;
    page: any;
    /** 将页面释放回进程内/跨进程页面池。 */
    releasePage(): Promise<void>;
};

export type OpenPlaywrightBrowserOptions = {
    hideWindow?: boolean;
};

export type AcquirePlaywrightPageOptions = {
    poolKey?: string;
    contextOptions?: any;
    preparePage?: (page: any) => Promise<void>;
    preferExistingContext?: boolean;
};

export type LoadPlaywrightClientOptions = {
    silent?: boolean;
};

export type LocalBrowserSessionMode = 'headed' | 'headless' | 'hidden-headed';

export type LocalBrowserSession = {
    browser: any;
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
};

export type LocalBrowserSessionMetadata = {
    domainKey?: string;
    metadataPath?: string;
    sessionMode: LocalBrowserSessionMode;
    browserPid?: number;
    debugPort?: number;
    tempDir: string;
    clientPids: number[];
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
    context: any | null;
    page: any;
    busy: boolean;
    prepared: boolean;
    pageTargetId: string;
    pageLock: NativeFileLockHandle | null;
};

export type BrowserPlaywrightPagePool = {
    poolKey: string;
    sharedContext: any | null;
    entries: PooledPlaywrightPageEntry[];
    preparePage?: (page: any) => Promise<void>;
    contextOptions?: any;
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
