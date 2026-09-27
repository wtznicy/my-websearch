import * as cheerio from 'cheerio';

export const GENERIC_BOT_KEYWORDS: readonly string[] = [
    'captcha',
    'verification',
    'verify you are human',
    'access denied',
    'blocked',
    'rate limit',
    'too many requests',
    'please enable javascript',
    'please verify',
    '请验证',
    '验证码',
    '人机验证',
    '安全验证'
];

export const BRAVE_BLOCKED_TITLE_KEYWORDS: readonly string[] = [
    'access denied',
    'unusual traffic',
    'verify you are human',
    'captcha',
    'request blocked',
    '访问被拒绝',
    '人机验证'
];

export const BING_BOT_DETECTION_KEYWORDS: readonly string[] = [
    'verify you are human',
    'unusual traffic',
    'robot or human',
    'enter the characters you see below',
    'solve the puzzle',
    'prove that you are not a robot',
    '请输入验证码',
    '输入验证码',
    '输入下图中的字符',
    '请完成拼图',
    '人机身份验证',
    '网络流量异常',
    '系统检测到异常流量',
    '访问过于频繁',
    '安全验证'
];

/**
 * 百度反爬/异常页面检测：
 * 对无 cookie 或可疑请求返回 <meta refresh> 跳转页（跳安全验证或首页），
 * 此时页面没有 #content_left 结果容器；安全验证页另有 wappass 跳转或"安全验证"文案特征。
 */
export function isBaiduAntiBotPage(html: string): boolean {
    const lower = html.toLowerCase();
    const hasMetaRefresh = /<meta[^>]*http-equiv=["']?\s*refresh/i.test(lower);
    const hasResultsContainer = /id=["']?content_left/i.test(lower);
    const securitySignals = lower.includes('wappass.baidu.com')
        || lower.includes('百度安全验证')
        || lower.includes('安全验证')
        || lower.includes('verify you are human');
    return (hasMetaRefresh && !hasResultsContainer) || securitySignals;
}

/**
 * Bing Impersonate 模式下的反爬页检测（按 title 和缺失结果标记判断）
 */
export function isBingAntiBotPage(html: string): boolean {
    const title = (html.match(/<title>(.*?)<\/title>/i) || [])[1]?.toLowerCase() ?? '';
    return /captcha|verify|access denied|blocked|验证|人机验证/.test(title) && !html.includes('b_algo');
}

/**
 * Bing 页面反爬深度分析。复用已加载的 cheerio 实例避免重复解析。
 */
export function analyzeBingBlockedPage($: cheerio.CheerioAPI, html: string): {
    blocked: boolean;
    hasResults: boolean;
    detectedKeywords: string[];
    title: string;
} {
    const normalized = html.toLowerCase();
    const title = $('title').first().text().trim().toLowerCase();
    const detectedKeywords = BING_BOT_DETECTION_KEYWORDS.filter((keyword) => normalized.includes(keyword));

    const resultSelector = '#b_results .b_algo, #b_results li.b_algo, .b_algo, .b_ans';
    const fallbackLinkSelector = '#b_results a[href], #b_topw a[href], .b_algo a[href], .b_ans a[href]';
    const hasResults = $(resultSelector).length > 0 || $(fallbackLinkSelector).length > 0;
    const hasCaptchaUi = $([
        'iframe[src*="captcha"]',
        '[id*="captcha"]',
        '[class*="captcha"]',
        'form[action*="validate"]',
        'input[name*="captcha"]',
        '#b_captcha',
        '.b_captcha'
    ].join(',')).length > 0;
    const hasStrongTitleSignal = [
        'captcha',
        'verify you are human',
        'access denied',
        'too many requests',
        '验证码',
        '人机验证',
        '请验证'
    ].some((keyword) => title.includes(keyword));
    const blocked = !hasResults && (hasCaptchaUi || hasStrongTitleSignal || detectedKeywords.length >= 2);

    return {
        blocked,
        hasResults,
        detectedKeywords,
        title
    };
}

/**
 * Brave 反爬/拦截页检测（按 title 关键词判断）
 */
export function isBraveBlockedPage(html: string): boolean {
    const title = cheerio.load(html)('title').first().text().trim().toLowerCase();
    return BRAVE_BLOCKED_TITLE_KEYWORDS.some((keyword) => title.includes(keyword));
}

/**
 * 搜狗验证码/拦截页检测
 */
export function isSogouChallengePage(html: string): boolean {
    const normalized = html.toLowerCase();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();

    return normalized.includes('antispider')
        || normalized.includes('请输入验证码')
        || normalized.includes('访问过于频繁')
        || title.includes('搜狗搜索验证');
}

/**
 * Startpage Captcha / 人机验证页检测
 */
export function isStartpageCaptchaPage(html: string): boolean {
    const normalized = html.toLowerCase();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim().toLowerCase();

    if (normalized.includes('/sp/captcha')) {
        return true;
    }

    const hasCaptchaUi = $([
        'form[action*="/sp/captcha"]',
        'iframe[src*="captcha"]',
        '[id*="captcha"]',
        '[class*="captcha"]'
    ].join(',')).length > 0;

    const hasVerificationText = [
        'verify you are human',
        'human verification',
        'security check'
    ].some((keyword) => normalized.includes(keyword) || title.includes(keyword));

    return hasCaptchaUi || hasVerificationText;
}

/**
 * 通用反爬/机器人拦截页面检测（如 CSDN / Web 内容抓取中的拦截）
 */
export function looksLikeBotChallengePage(html: string): boolean {
    const normalized = html.toLowerCase();
    return GENERIC_BOT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
