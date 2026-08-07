/**
 * Shared Playwright anti-detection utilities.
 *
 * bing.ts 原先内置了完整的 stealth 初始化脚本（webdriver/plugins/chrome/WebGL
 * 指纹伪造等）。抽取到本模块后，bing 搜索与 fetchWebContent 的浏览器兜底
 * （fetchPageHtmlWithBrowser）共用同一套反检测能力，避免重复实现。
 */

const STEALTH_BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const STEALTH_VIEWPORT = { width: 1920, height: 1080 };

/**
 * 注入浏览器指纹伪装：让自动化浏览器看起来像真实 Chrome。
 * 覆盖 navigator.webdriver / plugins / mimeTypes / chrome / WebGL / permissions 等。
 */
export async function setupAntiDetection(page: any): Promise<void> {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false
        });
        delete (navigator as any).__proto__.webdriver;

        Object.defineProperty(navigator, 'userAgent', {
            get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        Object.defineProperty(navigator, 'platform', {
            get: () => 'MacIntel'
        });
        Object.defineProperty(navigator, 'languages', {
            get: () => ['zh-CN', 'zh', 'en-US', 'en']
        });
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => 8
        });

        if (!(navigator as any).deviceMemory) {
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8
            });
        }

        const createPlugin = (name: string, filename: string, description: string, mimeTypes: any[]) => {
            const plugin: any = { name, filename, description, length: mimeTypes.length };
            mimeTypes.forEach((mimeType, index) => {
                plugin[index] = mimeType;
            });
            return plugin;
        };
        const createMimeType = (type: string, suffixes: string, description: string) => ({
            type,
            suffixes,
            description,
            enabledPlugin: {}
        });

        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                createPlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format', [createMimeType('application/x-google-chrome-pdf', 'pdf', 'Portable Document Format')]),
                createPlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', '', [createMimeType('application/pdf', 'pdf', '')]),
                createPlugin('Native Client', 'internal-nacl-plugin', '', [
                    createMimeType('application/x-nacl', '', 'Native Client Executable'),
                    createMimeType('application/x-pnacl', '', 'Portable Native Client Executable')
                ])
            ]
        });

        Object.defineProperty(navigator, 'mimeTypes', {
            get: () => {
                const mimeTypes: any[] = [];
                const plugins = navigator.plugins as any;
                for (let pluginIndex = 0; pluginIndex < plugins.length; pluginIndex += 1) {
                    const plugin = plugins[pluginIndex];
                    for (let mimeIndex = 0; mimeIndex < plugin.length; mimeIndex += 1) {
                        mimeTypes.push(plugin[mimeIndex]);
                    }
                }
                return mimeTypes;
            }
        });

        (window as any).chrome = {
            app: {
                InstallState: 'installed',
                RunningState: 'running',
                getDetails: () => null,
                getIsInstalled: () => false
            },
            csi: () => ({
                startE: Date.now(),
                onloadT: Date.now(),
                pageT: 100,
                tran: 15
            }),
            loadTimes: () => ({
                commitLoadTime: 0,
                connectionInfo: 'http/1.1',
                finishDocumentLoadTime: 0,
                finishLoadTime: 0,
                firstPaintAfterLoadTime: 0,
                firstPaintTime: 0,
                navigationType: 'Other',
                npnNegotiatedProtocol: 'unknown',
                requestTime: 0,
                startLoadTime: 0,
                wasAlternateProtocolAvailable: false,
                wasFetchedViaSpdy: false,
                wasNpnNegotiated: false
            }),
            runtime: {
                connect: () => ({
                    onConnect: { addListener: () => undefined },
                    onMessage: { addListener: () => undefined },
                    postMessage: () => undefined,
                    disconnect: () => undefined
                }),
                sendMessage: () => Promise.resolve({}),
                onConnect: { addListener: () => undefined },
                onMessage: { addListener: () => undefined }
            }
        };

        const originalQuery = (window.navigator.permissions as any).query;
        (window.navigator.permissions as any).query = (parameters: any) => {
            if (parameters.name === 'notifications') {
                return Promise.resolve({ state: Notification.permission });
            }
            return originalQuery ? originalQuery(parameters) : Promise.resolve({ state: 'granted' });
        };

        const webglGetParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
            if (parameter === 37445) {
                return 'Intel Inc.';
            }
            if (parameter === 37446) {
                return 'Intel(R) Iris(TM) Graphics 6100';
            }
            return webglGetParameter.call(this, parameter);
        };

        if (typeof WebGL2RenderingContext !== 'undefined') {
            const webgl2GetParameter = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function (parameter: number) {
                if (parameter === 37445) {
                    return 'Intel Inc.';
                }
                if (parameter === 37446) {
                    return 'Intel(R) Iris(TM) Graphics 6100';
                }
                return webgl2GetParameter.call(this, parameter);
            };
        }

        const viewportWidth = window.innerWidth || 1920;
        const viewportHeight = window.innerHeight || 1080;
        Object.defineProperty(window, 'outerWidth', { get: () => viewportWidth });
        Object.defineProperty(window, 'outerHeight', { get: () => viewportHeight });

        if (!(navigator as any).connection) {
            Object.defineProperty(navigator, 'connection', {
                get: () => ({
                    effectiveType: '4g',
                    rtt: 50,
                    downlink: 10,
                    saveData: false
                })
            });
        }

        const originalToString = Function.prototype.toString;
        Function.prototype.toString = function () {
            return originalToString.call(this).includes('[native code]') ? originalToString.call(this) : 'function () { [native code] }';
        };
    });
}

export function getStealthUserAgent(): string {
    return STEALTH_BROWSER_USER_AGENT;
}

export function getStealthViewport(): { width: number; height: number } {
    return { ...STEALTH_VIEWPORT };
}

/**
 * 通用页面伪装准备：注入 stealth 脚本 + 视口 + Accept-Language。
 * 供 bing 搜索和通用网页抓取复用。
 */
export async function prepareStealthPage(page: any): Promise<void> {
    await setupAntiDetection(page);
    if (typeof page.setViewportSize === 'function') {
        await page.setViewportSize(STEALTH_VIEWPORT).catch(() => undefined);
    }
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    });
}
