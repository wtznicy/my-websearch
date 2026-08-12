import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { BROWSER_USER_AGENT as BAIDU_USER_AGENT } from '../../utils/constants.js';
import { paginateSearch } from '../../utils/pagination.js';

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

export async function searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
    const seenUrls = new Set<string>();

    return paginateSearch({
        limit,
        fetchPage: async (pageIndex) => {
            const response = await axios.get('https://www.baidu.com/s', buildAxiosRequestOptions({ engine: 'baidu',
                trustedStaticHost: true,
                params: {
                    wd: query,
                    pn: (pageIndex * 10).toString(),
                    ie: "utf-8",
                    tn: "baiduhome_pg"
                },
                headers: {
                    'User-Agent': BAIDU_USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                }
            }));

            const $ = cheerio.load(response.data);
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
    });
}
