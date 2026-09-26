import axios from 'axios';
import * as cheerio from 'cheerio';
import { EngineSearchResponse, SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { BROWSER_USER_AGENT as BAIDU_USER_AGENT } from '../../utils/constants.js';
import { mapWithConcurrencyBudget } from '../../utils/concurrency.js';

const BAIDU_LINK_PREFIX = 'http://www.baidu.com/link?url=';

/** 压缩空白：兼容新版百度页面的多行/缩进噪声（title 前导换行、description 尾部空白等） */
function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/** URL 规范化：非 ASCII/空格由 URL 对象自动 percent-encode，避免 href 里的中文参数乱码 */
function normalizeResultUrl(rawHref: string): string {
    try {
        return new URL(rawHref).toString();
    } catch {
        return rawHref;
    }
}

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

/**
 * 反爬/异常页面检测：百度对无 cookie 或可疑请求返回 <meta refresh> 跳转页
 * （跳安全验证或首页），此时页面没有 #content_left 结果容器；安全验证页另有
 * wappass 跳转或"安全验证"文案特征。检测到反爬时由调用方显式抛错，
 * 避免"看似正常返回、实际解析不到任何结果"的静默失败。
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
 * 解析百度搜索结果里的中转跳转链接（http://www.baidu.com/link?url=...）。
 * 百度桌面端对每个结果生成一次性的跳转 URL，直接拿它无法 fetch 到真实页面。
 * 通过一次 HEAD 请求跟随重定向拿到最终目标 URL；失败时回退到原链接。
 */
async function resolveBaiduRedirectUrl(linkUrl: string): Promise<string> {
    if (!linkUrl.startsWith(BAIDU_LINK_PREFIX)) {
        return linkUrl;
    }

    try {
        const response = await axios.head(linkUrl, buildAxiosRequestOptions({ engine: 'baidu',
            trustedStaticHost: true,
            headers: {
                'User-Agent': BAIDU_USER_AGENT
            },
            maxRedirects: 3,
            timeout: 8000,
            validateStatus: (status: number) => status >= 200 && status < 400
        }));

        const finalUrl = response.request?.res?.responseUrl
            ?? (typeof response.request?.res?.headers?.location === 'string'
                ? response.request.res.headers.location
                : undefined);

        if (typeof finalUrl === 'string' && finalUrl.startsWith('http')) {
            return finalUrl;
        }

        return linkUrl;
    } catch (error) {
        console.error('⚠️ Failed to resolve Baidu redirect link:', error instanceof Error ? error.message : String(error));
        return linkUrl;
    }
}

/** 链接解析总预算：预算耗尽后剩余结果保留原中转链接（用户/LLM 仍可用），
 *  避免 N+1 的 HEAD 请求把引擎整体耗时推过单引擎超时上限（实测 10 条结果时
 *  解析阶段可累积数秒，导致 baidu 整体 14.6s 被 6s 上限掐断） */
const REDIRECT_RESOLVE_BUDGET_MS = 2000;
const REDIRECT_RESOLVE_CONCURRENCY = 6;

/** 带预算并发解析一批跳转链接：超预算的保留原链接 */
async function resolveBaiduRedirectUrls(hrefs: string[]): Promise<string[]> {
    return mapWithConcurrencyBudget(
        hrefs,
        REDIRECT_RESOLVE_CONCURRENCY,
        (href) => resolveBaiduRedirectUrl(href),
        REDIRECT_RESOLVE_BUDGET_MS,
        (href) => href
    );
}

/** 百度推广容器/链接特征：推广走加密跳转（baidu.php?url=）且常无描述，需在解析层剔除 */
function isBaiduAdContainer(element: any, $: any): boolean {
    const container = $(element);
    const className = String(container.attr('class') || '');
    // 经典广告标记：b_ad 容器、ec_ 前缀推广位 class、data-tuiguang 属性
    return container.hasClass('b_ad')
        || container.find('.b_ad').length > 0
        || /(^|\s)ec_\w*/.test(className)
        || container.attr('data-tuiguang') !== undefined;
}

function isBaiduAdLink(href: string): boolean {
    // 推广加密跳转（区别于自然结果的 www.baidu.com/link?url= 中转）：
    // baidu.php 推广链通常出现在广告位，直接剔除
    return /\/baidu\.php\?url=/i.test(href);
}

/**
 * 百度卡片/噪声的 tpl 标识（实测：卡片条目在 tpl 属性上区分，比 class 更稳定）。
 * 卡片类（jr_ 金融卡、new_baikan 百科摘要卡等）的首位文本即直接答案；
 * 噪声类（大家还在搜、反馈条）需在解析层剔除，不给 LLM 造成干扰。
 */
const BAIDU_DIRECT_ANSWER_TEMPLATES = /^(jr_|new_baikan|op_|bk_|weather|calc|time_)/;
const BAIDU_NOISE_TEMPLATES = new Set(['recommend_list', 'uer_feedback', 'san_']);

/** 直接答案卡片文本保留上限（防止把整卡 HTML 文本塞进响应） */
const DIRECT_ANSWER_MAX_CHARS = 300;

/**
 * 解析一页百度结果（提取 + 中转链接解析 + 页内去重）。
 * HTTP/impersonate 两条请求路径共用，保证两边的结果结构一致。
 * 返回的数组带 `directAnswer` 属性（若首屏存在汇率/百科等直接答案卡片）。
 */
export async function parseBaiduResultsPage(html: string, seenUrls: Set<string>): Promise<EngineSearchResponse> {
    const $ = cheerio.load(html);
    const elements = $('#content_left').children().toArray();

    // 第一遍：只收集原始数据，避免在循环里串行 await 解析跳转链
    const collected: Array<{ title: string; href: string; description: string; source: string }> = [];
    let directAnswer: string | undefined;
    for (const element of elements) {
        const template = String($(element).attr('tpl') || '');

        // 噪声条目（大家还在搜/反馈条）直接跳过
        if (BAIDU_NOISE_TEMPLATES.has(template)) {
            continue;
        }

        // 直接答案卡片：提取首位文本作为 directAnswer（汇率换算、百科摘要等）
        if (!directAnswer && BAIDU_DIRECT_ANSWER_TEMPLATES.test(template)) {
            const cardText = normalizeWhitespace($(element).text());
            if (cardText && cardText.length >= 10) {
                directAnswer = cardText.slice(0, DIRECT_ANSWER_MAX_CHARS);
            }
            // 卡片通常没有可跳转的自然结果链接，继续走后续解析（若有 h3 链接则同时作为结果保留）
        }

        // 跳过推广容器（广告伪装成自然结果混入，不在 .b_ad 里的推广位同样要拦）
        if (isBaiduAdContainer(element, $)) {
            continue;
        }

        // 标题只取当前结果容器内的第一个 h3（旧选择器会误匹配容器内多个 h3，把多个标题拼成一个）
        const titleElement = $(element).find('h3').first();
        const linkElement = titleElement.find('a[href]').first();
        const href = linkElement.attr('href');
        if (!href || !href.startsWith('http') || isBaiduAdLink(href)) {
            continue;
        }

        const snippetElement = $(element).find('.c-font-normal.c-color-text, .cos-row').first();
        const sourceElement = $(element).find('.cosc-source').first();
        const sourceText = normalizeWhitespace(sourceElement.text());
        let description = normalizeWhitespace(snippetElement.attr('aria-label') || snippetElement.text() || '');
        // aria-label/摘要尾部偶尔会带上来源文本（如 "…腾讯云计算"），去掉避免与 source 重复
        if (description && sourceText && description.endsWith(sourceText)) {
            description = description.slice(0, -sourceText.length).trim();
        }
        collected.push({
            title: normalizeWhitespace(titleElement.text()),
            href,
            description,
            source: sourceText
        });
    }

    // 第二遍：并发解析真实 URL，再统一入结果（页内按 URL 去重）
    const resolvedHrefs = await resolveBaiduRedirectUrls(collected.map((item) => item.href));
    const results: SearchResult[] = [];
    collected.forEach((item, index) => {
        const resolvedHref = resolvedHrefs[index];
        const url = resolvedHref ? normalizeResultUrl(resolvedHref) : '';
        if (!url || seenUrls.has(url)) {
            return;
        }
        seenUrls.add(url);
        results.push({
            title: item.title,
            url,
            description: item.description,
            source: item.source || hostnameOf(url),
            engine: 'baidu'
        });
    });

    const response = results as EngineSearchResponse;
    if (directAnswer) {
        response.directAnswer = directAnswer;
    }
    return response;
}
