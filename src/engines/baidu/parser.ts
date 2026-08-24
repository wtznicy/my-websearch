import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { BROWSER_USER_AGENT as BAIDU_USER_AGENT } from '../../utils/constants.js';

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

/** 并发解析一批跳转链接（限制并发 4），避免逐条串行 HEAD（N+1）拖慢整页 */
async function resolveBaiduRedirectUrls(hrefs: string[]): Promise<string[]> {
    const resolved = new Array<string>(hrefs.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(4, hrefs.length) }, async () => {
        while (next < hrefs.length) {
            const index = next;
            next += 1;
            resolved[index] = await resolveBaiduRedirectUrl(hrefs[index]);
        }
    });
    await Promise.all(workers);
    return resolved;
}

/**
 * 解析一页百度结果（提取 + 中转链接解析 + 页内去重）。
 * HTTP/impersonate 两条请求路径共用，保证两边的结果结构一致。
 */
export async function parseBaiduResultsPage(html: string, seenUrls: Set<string>): Promise<SearchResult[]> {
    const $ = cheerio.load(html);
    const elements = $('#content_left').children().toArray();

    // 第一遍：只收集原始数据，避免在循环里串行 await 解析跳转链
    const collected: Array<{ title: string; href: string; description: string; source: string }> = [];
    for (const element of elements) {
        // 标题只取当前结果容器内的第一个 h3（旧选择器会误匹配容器内多个 h3，把多个标题拼成一个）
        const titleElement = $(element).find('h3').first();
        const linkElement = titleElement.find('a[href]').first();
        const href = linkElement.attr('href');
        if (!href || !href.startsWith('http')) {
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
        const url = normalizeResultUrl(resolvedHrefs[index]);
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

    return results;
}
