/**
 * Browser Resource Blocker
 *
 * 借鉴 Scrapling 的 Aggressive Resource Blocking 机制：
 * 无头浏览器（Playwright）在加载目标网页或预热防反爬 Cookie 时，默认会下载页面中包含的
 * 大量高带宽无用资源（图片、音视频、外部字体）以及高频轮询的第三方广告与统计打点脚本
 * （如 Google Analytics、百度统计、Sentry、Clarity 等）。
 *
 * 这些请求不仅消耗数倍的带宽与内存，还常常导致 networkidle 超时。
 * 本模块在 Playwright Route 层直接 abort 掉这些无用资源，大幅降低延迟与资源占用，
 * 同时完全保留 DOM 结构、CSS 布局与正文内容提取（Readability / Turndown）所需的 HTML 标签与属性。
 */

export interface SubresourceRequestLike {
    url(): string;
    isNavigationRequest?(): boolean;
    resourceType?(): string;
}

export interface ResourceBlockerPageLike {
    route?(url: string | RegExp | ((url: URL) => boolean), handler: (route: {
        request(): SubresourceRequestLike;
        abort(errorCode?: string): Promise<void>;
        continue(): Promise<void>;
    }) => Promise<void> | void): Promise<void>;
}

export const RESOURCE_BLOCKER_INSTALLED = Symbol('resourceBlockerInstalled');

/**
 * Playwright 明确支持的且在纯文本提取与 Cookie 预热中完全不需要下载的资源类型
 */
export const BLOCKED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
    'image',
    'media',
    'font',
    'texttrack',
    'imageset'
]);

/**
 * 常见媒体与字体文件扩展名（用于兜底部分 resourceType 为 'other' 或未能识别的场景）
 */
export const BLOCKED_RESOURCE_EXTENSIONS: RegExp =
    /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|wav|avi|mov|mkv|flv|wmv|m4a|aac)$/i;

export const BLOCKED_FILE_EXTENSIONS = BLOCKED_RESOURCE_EXTENSIONS;

/**
 * 已知的第三方统计、遥测打点与广告分析追踪域名（精确或后缀匹配）
 */
export const BLOCKED_TRACKER_DOMAINS: readonly string[] = [
    'google-analytics.com',
    'googletagmanager.com',
    'analytics.google.com',
    'doubleclick.net',
    'adservice.google.com',
    'googleadservices.com',
    'hm.baidu.com',
    'tongji.baidu.com',
    'cnzz.com',
    'cnzz.net',
    'umeng.com',
    'clarity.ms',
    'hotjar.com',
    'scorecardresearch.com',
    'quantserve.com',
    'criteo.com',
    'criteo.net',
    'taboola.com',
    'outbrain.com',
    'sentry.io',
    'browser.sentry-cdn.com',
    'segment.io',
    'segment.com',
    'growingio.com',
    'sensorsdata.cn',
    'ads.twitter.com',
    'analytics.twitter.com',
    'connect.facebook.net',
    'facebook.net'
];

/**
 * 检查主机名是否属于已知的第三方分析追踪域名
 */
export function isTrackerHost(hostname: string): boolean {
    if (!hostname) {
        return false;
    }
    const lower = hostname.toLowerCase();
    for (const pattern of BLOCKED_TRACKER_DOMAINS) {
        if (lower === pattern || lower.endsWith('.' + pattern)) {
            return true;
        }
    }
    return false;
}

/**
 * 判定给定的浏览器子资源请求是否属于应主动丢弃的无用资源
 *
 * 保护契约：
 * 1. 顶级主文档导航请求（navigation request）绝对不拦截；
 * 2. 样式表（CSS）与核心脚本不拦截（防止破坏 SPA 渲染及 Readability 依赖的可见性样式）；
 * 3. 仅拦截图片、多媒体、字体与已知纯追踪打点域名。
 */
export function isBlockedBrowserSubresource(request: SubresourceRequestLike): boolean {
    // 顶级导航请求（主页面）绝不拦截
    if (typeof request.isNavigationRequest === 'function' && request.isNavigationRequest()) {
        return false;
    }

    // 1. Playwright 明确标注的无用资源类型
    if (typeof request.resourceType === 'function') {
        const type = request.resourceType();
        if (type && BLOCKED_RESOURCE_TYPES.has(type)) {
            return true;
        }
    }

    const rawUrl = typeof request.url === 'function' ? request.url() : '';
    if (!rawUrl) {
        return false;
    }

    // 2. 解析 URL 路径与域名
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }

    // 扩展名过滤（兜底未标注 resourceType 的图片/视频/字体）
    if (BLOCKED_RESOURCE_EXTENSIONS.test(parsed.pathname)) {
        return true;
    }

    // 3. 已知广告/统计追踪打点域名
    if (parsed.hostname && isTrackerHost(parsed.hostname)) {
        return true;
    }

    return false;
}

/**
 * 为 Playwright 页面挂载轻量级无用资源拦截器。
 * 若页面已挂载过拦截器（或已挂载导航守卫），则跳过以防重复注册。
 */
export async function installBrowserResourceBlocker(page: unknown): Promise<void> {
    const candidate = page as (ResourceBlockerPageLike & { [RESOURCE_BLOCKER_INSTALLED]?: boolean }) | null | undefined;
    if (!candidate || candidate[RESOURCE_BLOCKER_INSTALLED] || typeof candidate.route !== 'function') {
        return;
    }

    try {
        await candidate.route('**/*', async (route) => {
            const request = route.request();
            if (isBlockedBrowserSubresource(request)) {
                await route.abort('blockedbyclient').catch(() => route.abort().catch(() => undefined));
                return;
            }
            await route.continue().catch(() => undefined);
        });
        candidate[RESOURCE_BLOCKER_INSTALLED] = true;
    } catch {
        // 部分通过 CDP 连接的外部持久化浏览器或已销毁页面可能不支持 route 拦截，静默降级
    }
}
