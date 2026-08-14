import * as cheerio from 'cheerio';
import { fetchPageHtmlWithBrowser, getBrowserCookieHeader, looksLikeBotChallengePage } from '../../utils/browserCookies.js';
import { buildAxiosRequestOptions, requestWithSafeRedirects } from '../../utils/httpRequest.js';

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

function stripPromotionSections(text: string): string {
    if (!text) {
        return text;
    }
    const paragraphs = text.split('\n\n');
    const kept = paragraphs.filter((paragraph) => !CSDN_PROMO_KEYWORDS.some((keyword) => paragraph.includes(keyword)));
    return kept.join('\n\n').trim();
}

function buildRequestOptions(cookieHeader?: string): any {
    const headers: Record<string, string> = {
        'Accept': '*/*',
        'Host': 'blog.csdn.net',
        'Connection': 'keep-alive',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    };
    const requestOptions = buildAxiosRequestOptions({ headers });

    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    return requestOptions;
}

function extractArticleContent(html: string): string {
    const $ = cheerio.load(html);
    const article = $('#content_views').first();
    article.find('script, style, noscript').remove();
    return stripPromotionSections(normalizeExtractedText(article.text()));
}

function shouldRetryWithBrowser(html: string, content: string): boolean {
    return !content || (looksLikeBotChallengePage(html) && content.length < 200);
}

export async function fetchCsdnArticle(url: string): Promise<{ content: string }> {
    let response: any;
    let html = '';
    let content = '';

    try {
        response = await requestWithSafeRedirects('GET', url, buildRequestOptions());
        html = String(response.data || '');
        content = extractArticleContent(html);
    } catch (error: any) {
        const status = error?.response?.status;
        if (![401, 403, 429].includes(status)) {
            throw error;
        }

        const cookieHeader = await getBrowserCookieHeader(url);
        if (cookieHeader) {
            try {
                response = await requestWithSafeRedirects('GET', url, buildRequestOptions(cookieHeader));
                html = String(response.data || '');
                content = extractArticleContent(html);
            } catch {
                const browserPage = await fetchPageHtmlWithBrowser(url);
                html = browserPage.html;
                content = extractArticleContent(html);
            }
        } else {
            const browserPage = await fetchPageHtmlWithBrowser(url);
            html = browserPage.html;
            content = extractArticleContent(html);
        }
    }

    if (shouldRetryWithBrowser(html, content)) {
        const cookieHeader = await getBrowserCookieHeader(url);
        if (cookieHeader) {
            try {
                response = await requestWithSafeRedirects('GET', url, buildRequestOptions(cookieHeader));
                html = String(response.data || '');
                content = extractArticleContent(html);
            } catch {
                const browserPage = await fetchPageHtmlWithBrowser(url);
                html = browserPage.html;
                content = extractArticleContent(html);
            }
        }

        if (shouldRetryWithBrowser(html, content)) {
            const browserPage = await fetchPageHtmlWithBrowser(url);
            html = browserPage.html;
            content = extractArticleContent(html);
        }
    }

    if (!content) {
        throw new Error('Failed to extract readable CSDN article content');
    }

    return { content };
}
