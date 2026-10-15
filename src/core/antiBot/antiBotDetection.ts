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
    '安全验证',
    '你似乎来到了没有知识存在的荒原',
    '没有知识存在的荒原',
    '系统检测到异常',
    '访问受限'
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
    isNoResults: boolean;
    detectedKeywords: string[];
    title: string;
} {
    const normalized = html.toLowerCase();
    const title = $('title').first().text().trim().toLowerCase();
    const detectedKeywords = BING_BOT_DETECTION_KEYWORDS.filter((keyword) => normalized.includes(keyword));

    const resultSelector = '#b_results .b_algo, #b_results li.b_algo, .b_algo, .b_ans';
    const fallbackLinkSelector = '#b_results a[href], #b_topw a[href], .b_algo a[href], .b_ans a[href]';
    const hasResults = $(resultSelector).length > 0 || $(fallbackLinkSelector).length > 0;
    const isNoResults = $('.b_no').length > 0
        || $('#b_results > li.b_no').length > 0
        || /没有与此相关的结果|找不到和您的查询相符的结果|no results found for|there are no results for/i.test($('#b_results').text() || $('body').text() || '');
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
    const blocked = !hasResults && !isNoResults && (hasCaptchaUi || hasStrongTitleSignal || detectedKeywords.length >= 2);

    return {
        blocked,
        hasResults,
        isNoResults,
        detectedKeywords,
        title
    };
}

/**
 * Brave 反爬/拦截页检测（按 title 关键词判断）
 */
export function isBraveBlockedPage(html: string, $doc?: cheerio.CheerioAPI): boolean {
    const $ = $doc ?? cheerio.load(html);
    const title = $('title').first().text().trim().toLowerCase();
    return BRAVE_BLOCKED_TITLE_KEYWORDS.some((keyword) => title.includes(keyword));
}

/**
 * 搜狗验证码/拦截页检测
 */
export function isSogouChallengePage(html: string, $doc?: cheerio.CheerioAPI): boolean {
    const normalized = html.toLowerCase();
    const $ = $doc ?? cheerio.load(html);
    const title = $('title').first().text().trim();

    return normalized.includes('antispider')
        || normalized.includes('请输入验证码')
        || normalized.includes('访问过于频繁')
        || title.includes('搜狗搜索验证');
}

/**
 * Startpage Captcha / 人机验证页检测
 */
export function isStartpageCaptchaPage(html: string, $doc?: cheerio.CheerioAPI): boolean {
    const normalized = html.toLowerCase();
    const $ = $doc ?? cheerio.load(html);
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

export const UNAMBIGUOUS_BOT_CHALLENGE_KEYWORDS: readonly string[] = [
    'verify you are human',
    'solve the captcha',
    'complete the captcha',
    'enter the captcha',
    'please enable javascript',
    'enable javascript and cookies',
    'checking your browser',
    'just a moment',
    'attention required',
    'unusual traffic',
    'robot or human',
    'prove that you are not a robot',
    '请完成验证',
    '完成安全验证',
    '请输入验证码',
    '人机验证',
    '你似乎来到了没有知识存在的荒原',
    '没有知识存在的荒原',
    '系统检测到异常',
    '访问过于频繁'
];

export const CONTEXTUAL_BOT_CHALLENGE_KEYWORDS: readonly string[] = [
    'human verification',
    'security verification',
    'security check',
    'please verify',
    'access denied',
    'too many requests',
    '请验证',
    '完成验证',
    '安全验证',
    '环境异常',
    '访问受限'
];

export const STRONG_BOT_CHALLENGE_KEYWORDS: readonly string[] = [
    ...UNAMBIGUOUS_BOT_CHALLENGE_KEYWORDS,
    ...CONTEXTUAL_BOT_CHALLENGE_KEYWORDS
];

const TECHNICAL_DOC_INDICATORS = /\b(?:api|sdk|guide|tutorial|documentation|docs|reference|middleware|component|configuration|config|implementation|example|endpoint|token|oauth|jwt|webhook|handler|controller|router|plugin|library|framework)\b|教程|文档|指南|配置|组件|中间件|接口|实战|开发|源码|实现/i;

export interface BotChallengeDetectOptions {
    /** HTTP 响应状态码（如 202/403/429/503），用于组合信号判定 */
    status?: number;
}

const ABNORMAL_CHALLENGE_STATUS_CODES = new Set<number>([202, 403, 429, 503]);

const SCRIPT_OR_META_CHALLENGE_PATTERNS = /(?:_?cf_chl_opt|cdn-cgi\/challenge-platform|acw_sc__v2|waf_captcha|wappass\.baidu\.com|initGeetest|gt4\.js|sec_waf|aliyun_waf|tcaptcha)/i;

/**
 * 通用反爬/机器人拦截页面检测（如 CSDN / Web 内容抓取中的拦截）。
 * 采用多维组合信号判定：
 * 1. HTTP 状态码异常（202/403/429/503）
 * 2. 页面不含预期正文容器或正文极短（< 350 字符）
 * 3. <title> / <meta> / 特定 form 或 script 出现 challenge 特征
 * 4. 排除含代码块或明确技术文档特征的正常短文，避免误判。
 */
export function looksLikeBotChallengePage(
    htmlOrText: string,
    options?: BotChallengeDetectOptions
): boolean {
    if (!htmlOrText || !htmlOrText.trim()) {
        return false;
    }

    const isAbnormalStatus = typeof options?.status === 'number'
        && ABNORMAL_CHALLENGE_STATUS_CODES.has(options.status);

    const isHtml = /<[a-z!][\s\S]*>/i.test(htmlOrText);
    if (!isHtml) {
        const compact = htmlOrText.replace(/\s+/g, ' ').trim();
        if (compact.length >= 350) {
            return false;
        }
        const lower = compact.toLowerCase();
        if (UNAMBIGUOUS_BOT_CHALLENGE_KEYWORDS.some((keyword) => lower.includes(keyword))) {
            return true;
        }
        if (TECHNICAL_DOC_INDICATORS.test(compact)) {
            return false;
        }
        if (isAbnormalStatus && compact.length < 200 && /(?:captcha|blocked|forbidden|challenge|rate\s*limit|访问|验证|拦截)/i.test(compact)) {
            return true;
        }
        return CONTEXTUAL_BOT_CHALLENGE_KEYWORDS.some((keyword) => lower.includes(keyword));
    }

    const $ = cheerio.load(htmlOrText);
    const title = $('title').first().text().replace(/\s+/g, ' ').trim().toLowerCase();
    const hasCodeElements = $('pre, code').length > 0;

    // 在移除 script/meta 前提取脚本与 meta 跳转中的反爬挑战信号
    const metaRefreshContent = $('meta[http-equiv="refresh"], meta[http-equiv="Refresh"]').attr('content') ?? '';
    const scriptContentSample = $('script')
        .map((_, el) => $(el).attr('src') || $(el).html() || '')
        .get()
        .join('\n')
        .slice(0, 8000);
    const hasChallengeScriptOrMeta = SCRIPT_OR_META_CHALLENGE_PATTERNS.test(scriptContentSample)
        || /(?:captcha|challenge|wappass|verify|validate|antispider)/i.test(metaRefreshContent);

    $('script, style, noscript, template, svg, canvas').remove();

    const mainContainerSelector = 'article, main, [role="main"], .markdown-body, .article-content, .post-content, .entry-content, #content_views';
    const hasMainContainer = $(mainContainerSelector).length > 0;
    const mainContainerText = $(mainContainerSelector).text().replace(/\s+/g, ' ').trim();
    if (mainContainerText.length >= 350) {
        return false;
    }

    const bodyText = ($('body').length > 0 ? $('body').text() : $.root().text()).replace(/\s+/g, ' ').trim();
    if (bodyText.length >= 350) {
        return false;
    }

    const hasChallengeDom = $([
        'iframe[src*="captcha"]',
        'iframe[src*="challenge"]',
        'iframe[src*="turnstile"]',
        '#challenge-running',
        '#cf-challenge-running',
        '.cf-turnstile',
        '.g-recaptcha',
        '.h-captcha',
        'form[action*="validate"]',
        'form[action*="/captcha"]'
    ].join(',')).length > 0;
    if (hasChallengeDom || hasChallengeScriptOrMeta) {
        return true;
    }

    const combinedLower = `${title}\n${bodyText.toLowerCase()}`;
    if (UNAMBIGUOUS_BOT_CHALLENGE_KEYWORDS.some((keyword) => combinedLower.includes(keyword))) {
        return true;
    }

    if (hasCodeElements || TECHNICAL_DOC_INDICATORS.test(combinedLower)) {
        return false;
    }

    if (/^(?:captcha|verification(?:\s+required)?|access\s+denied|security\s+check|blocked|验证码|安全验证)$/i.test(title)) {
        return true;
    }

    // 组合信号：HTTP 状态码异常 + 无预期正文容器 + 正文极短 + 出现拦截/挑战词汇
    if (isAbnormalStatus && !hasMainContainer && bodyText.length < 200) {
        if (/(?:captcha|blocked|forbidden|challenge|cloudflare|waf|验证|拦截|受限|频繁)/i.test(combinedLower)) {
            return true;
        }
    }

    return CONTEXTUAL_BOT_CHALLENGE_KEYWORDS.some((keyword) => combinedLower.includes(keyword));
}



