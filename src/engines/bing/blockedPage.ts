import * as cheerio from 'cheerio';
import type { AxiosRequestConfig } from 'axios';
import { config } from '../../config.js';
import { buildAxiosRequestOptions as buildSharedAxiosRequestOptions } from '../../utils/httpRequest.js';
import { DEFAULT_DESKTOP_UA, DESKTOP_UA_POOL } from '../../utils/userAgents.js';
import { analyzeBingBlockedPage } from '../../core/antiBot/antiBotDetection.js';

// 默认面向大陆部署的 cn.bing.com；可通过 BING_BASE_URL 覆盖为 www.bing.com 等获取国际区结果
export function getBingHomeUrl(): string {
    try {
        const url = new URL(config.bingBaseUrl || 'https://cn.bing.com/search');
        return `${url.origin}/?mkt=zh-CN`;
    } catch {
        return 'https://www.bing.com/?mkt=zh-CN';
    }
}

export const BROWSER_USER_AGENT = DEFAULT_DESKTOP_UA;

// 更接近真实浏览器的请求头集合（EnhancedBing 同款反爬对抗）：
// 随机 UA/语言、全套 Sec-Fetch 头、随机 MUID cookie，降低被 Bing 反爬拦截的概率。
export const BROWSER_USER_AGENTS = DESKTOP_UA_POOL;
export const ACCEPT_LANGUAGES = [
    'zh-CN,zh;q=0.9,en;q=0.8',
    'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'zh-CN,zh-Hans;q=0.9,en;q=0.8',
    'zh-CN,zh;q=0.8,en-US;q=0.7,en;q=0.6'
];
export const SEC_CH_UA_VARIANTS = [
    '"Not_A Brand";v="8", "Chromium";v="133", "Google Chrome";v="133"',
    '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
    '"Not_A Brand";v="99", "Chromium";v="132", "Google Chrome";v="132"'
];

export function pickRandom<T>(items: readonly T[]): T {
    const item = items[Math.floor(Math.random() * items.length)];
    if (item === undefined) {
        throw new Error('Cannot pick from an empty array');
    }
    return item;
}

export function generateMuid(): string {
    // 与浏览器生成的 MUID 格式相近的随机值
    return `${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;
}

export function buildBingAntiDetectionHeaders(): Record<string, string> {
    const userAgent = pickRandom(BROWSER_USER_AGENTS);
    const acceptLanguage = pickRandom(ACCEPT_LANGUAGES);
    const secChUa = pickRandom(SEC_CH_UA_VARIANTS);

    return {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Sec-Ch-Ua': secChUa,
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'DNT': '1',
        // 随机 MUID cookie，模拟浏览器首次访问 Bing 的状态
        'Cookie': `SRCHHPGUSR=SRCHLANG=zh-Hans; _EDGE_S=ui=zh-cn; _EDGE_V=1; MUID=${generateMuid()}`
    };
}

export const BOT_DETECTION_KEYWORDS = [
    'captcha',
    'verification',
    'verify you are human',
    'access denied',
    'blocked',
    'rate limit',
    'too many requests',
    '请验证',
    '验证码',
    '人机验证'
];

/**
 * 判断 Bing 页面是否被反爬拦截。复用调用方的 load 后 cheerio 文档实例，
 * 避免与正式提取重复解析同一个 HTML（原实现每页 load 3 次）。
 */
export function analyzeBlockedPage($: cheerio.CheerioAPI, html: string): ReturnType<typeof analyzeBingBlockedPage> {
    return analyzeBingBlockedPage($, html);
}

export function __analyzeBlockedPageForTests($: cheerio.CheerioAPI, html: string): ReturnType<typeof analyzeBingBlockedPage> {
    return analyzeBlockedPage($, html);
}

export function buildBingAxiosRequestOptions(signal?: AbortSignal): AxiosRequestConfig {
    return buildSharedAxiosRequestOptions({
        engine: 'bing',
        trustedStaticHost: true,
        headers: buildBingAntiDetectionHeaders(),
        timeout: config.playwrightNavigationTimeoutMs,
        signal
    });
}
