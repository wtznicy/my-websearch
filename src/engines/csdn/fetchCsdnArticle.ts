import * as cheerio from 'cheerio';
import { fetchPageHtmlWithBrowser, getBrowserCookieHeader, looksLikeBotChallengePage } from '../../utils/browserCookies.js';
import { buildAxiosRequestOptions, hintProxyConnectionError, requestDirectFirst, requestWithSafeRedirects } from '../../utils/httpRequest.js';

function normalizeExtractedText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * CSDN 文章正文尾部常混入社区推广段落（如"九天&菜菜…30+套原创系统教程…扫🐎进入大模型技术社区"）。
 * 按段落（\n\n）拆分后剔除命中推广特征词的段落，避免广告噪音进入抓取结果。
 */
const CSDN_PROMO_KEYWORDS = [
    '扫码', '扫🐎', '扫马',              // 二维码引导
    '大模型技术社区',                     // 推广社区名
    '原创系统教程',                       // 教程推广
    '免费公开',                           // 推广句式
    '项目源码包',                         // 源码获取引导
    '完整视频讲解'                        // 视频推广
];

/**
 * 单个泛化特征词（如「免费公开」「项目源码包」）出现在**长正文段落**里时不应整段删除——
 * 实测推广段都是"短句 + 命中多个特征"，而按关键词整段过滤会误删正文。
 */
function isPromotionParagraph(paragraph: string): boolean {
    const hits = CSDN_PROMO_KEYWORDS.filter((keyword) => paragraph.includes(keyword));
    if (hits.length === 0) {
        return false;
    }
    return paragraph.length <= 120 || hits.length >= 2;
}

function stripPromotionSections(text: string): string {
    if (!text) {
        return text;
    }
    const paragraphs = text.split('\n\n');
    const kept = paragraphs.filter((paragraph) => !isPromotionParagraph(paragraph));
    return kept.join('\n\n').trim();
}

function buildRequestOptions(cookieHeader?: string, forceDirect = false): any {
    const headers: Record<string, string> = {
        'Accept': '*/*',
        'Host': 'blog.csdn.net',
        'Connection': 'keep-alive',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    };
    // CSDN 是国内站点，强制直连：不因全局 USE_PROXY 走代理（代理挂掉时 CSDN 抓取不受影响）
    const requestOptions = buildAxiosRequestOptions({ headers, forceDirect });

    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    return requestOptions;
}

/**
 * 正文容器候选（按优先级）：此前只认 `#content_views` 单选择器、无兜底——
 * 页面结构变化或命中其它模板时正文会被截成几百字节（测评报告 B8：完整长文只拿到 572 字节）。
 */
const CSDN_CONTENT_SELECTORS = [
    '#content_views',
    '.article_content',
    '.htmledit_views',
    '#article_content',
    '.blog-content-box',
    'article'
];

function extractArticleContent(html: string): string {
    const $ = cheerio.load(html);
    $('script, style, noscript').remove();

    let best = '';
    for (const selector of CSDN_CONTENT_SELECTORS) {
        const container = $(selector).first();
        if (container.length === 0) {
            continue;
        }
        const candidate = normalizeExtractedText(container.text());
        if (candidate.length > best.length) {
            best = candidate;
        }
        // 已拿到像样的正文就不必再试更宽的选择器（越靠后越容易带上评论/导航噪声）
        if (best.length >= 800) {
            break;
        }
    }

    if (best.length < 200) {
        // 所有候选都过短（模板变化/SSR 差异）：退到 body 纯文本，并剔掉常见噪声区块
        $('nav, header, footer, aside, .comment, .recommend-box, .toolbar').remove();
        const fallback = normalizeExtractedText($('body').text());
        if (fallback.length > best.length) {
            best = fallback;
        }
    }

    return stripPromotionSections(best);
}

/** 供单测使用（正文容器兜底 + 推广段判定都是纯函数） */
export const __csdnArticleInternals = { extractArticleContent, isPromotionParagraph };

/**
 * 浏览器兜底（cookie 预热 / 渲染抓取）的**总预算**。
 * 实测：文章页返回 521 时，兜底链最多会触发 4 次 Playwright 操作（cookie×2 + 渲染×2），
 * 每次导航上限 20s，累积到 **64s 才失败**——远超 MCP 客户端 30s 预算，调用方只会看到超时。
 * 因此给整条兜底链一个总预算，超时即失败并保留上游真实原因（如 521）。
 */
const CSDN_BROWSER_FALLBACK_BUDGET_MS = 20000;

function createBrowserBudget(label: string) {
    const deadline = Date.now() + CSDN_BROWSER_FALLBACK_BUDGET_MS;
    return function withinBudget<T>(promise: Promise<T>, step: string): Promise<T> {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            return Promise.reject(new Error(`${label} browser fallback budget (${CSDN_BROWSER_FALLBACK_BUDGET_MS}ms) exhausted before ${step}`));
        }
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`${label} browser fallback budget (${CSDN_BROWSER_FALLBACK_BUDGET_MS}ms) exceeded during ${step}`)),
                remaining
            );
            if (typeof timer.unref === 'function') timer.unref();
            promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
        });
    };
}

function shouldRetryWithBrowser(html: string, content: string): boolean {
    return !content || (looksLikeBotChallengePage(html) && content.length < 200);
}

export async function fetchCsdnArticle(url: string): Promise<{ content: string }> {
    let response: any;
    let html = '';
    let content = '';
    // 浏览器兜底总预算（见 createBrowserBudget 注释）+ 首次失败原因（用于最终错误信息）
    const withinBrowserBudget = createBrowserBudget('CSDN');
    let firstError: any = null;

    try {
        // 直连优先、代理兜底：CSDN 国内直连最快，网络失败且配置了代理时自动切换
        response = await requestDirectFirst('GET', url, (forceDirect) => buildRequestOptions(undefined, forceDirect));
        html = String(response.data || '');
        content = extractArticleContent(html);
    } catch (error: any) {
        firstError = error;
        const status = error?.response?.status;
        // 浏览器 Cookie 兜底触发条件：认证/限流（401/403/429）与 5xx 服务端临时故障
        // （500/502/503 及 Cloudflare WAF 的 521/522）——这些状态下换浏览器会话/带 Cookie
        // 往往能拿到内容，直接抛错会浪费兜底路径
        if (![401, 403, 429, 500, 502, 503, 521, 522].includes(status)) {
            throw hintProxyConnectionError(error);
        }

        try {
            const cookieHeader = await withinBrowserBudget(getBrowserCookieHeader(url), 'cookie warm-up');
            if (cookieHeader) {
                try {
                    response = await requestWithSafeRedirects('GET', url, buildRequestOptions(cookieHeader));
                    html = String(response.data || '');
                    content = extractArticleContent(html);
                } catch {
                    const browserPage = await withinBrowserBudget(fetchPageHtmlWithBrowser(url), 'browser render');
                    html = browserPage.html;
                    content = extractArticleContent(html);
                }
            } else {
                const browserPage = await withinBrowserBudget(fetchPageHtmlWithBrowser(url), 'browser render');
                html = browserPage.html;
                content = extractArticleContent(html);
            }
        } catch (fallbackError) {
            // 兜底链失败（含预算耗尽）：把上游真实原因（如 521）一并带到错误信息里
            const upstream = error instanceof Error ? error.message : String(error);
            const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            throw new Error(`CSDN article fetch failed: ${upstream} (fallback: ${detail})`);
        }
    }

    if (shouldRetryWithBrowser(html, content)) {
        const cookieHeader = await withinBrowserBudget(getBrowserCookieHeader(url), 'cookie warm-up');
        if (cookieHeader) {
            try {
                response = await requestWithSafeRedirects('GET', url, buildRequestOptions(cookieHeader));
                html = String(response.data || '');
                content = extractArticleContent(html);
            } catch {
                const browserPage = await withinBrowserBudget(fetchPageHtmlWithBrowser(url), 'browser render');
                html = browserPage.html;
                content = extractArticleContent(html);
            }
        }

        if (shouldRetryWithBrowser(html, content)) {
            const browserPage = await withinBrowserBudget(fetchPageHtmlWithBrowser(url), 'browser render');
            html = browserPage.html;
            content = extractArticleContent(html);
        }
    }

    if (!content) {
        // 兜底耗尽时保留上游真实原因（如 521/502），而不是只说"提取不到内容"
        if (firstError) {
            throw hintProxyConnectionError(firstError);
        }
        throw new Error('Failed to extract readable CSDN article content');
    }

    return { content };
}
