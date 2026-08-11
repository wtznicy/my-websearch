import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

// 与 fetchWebContent 等模块一致的现代浏览器 UA，避免旧 UA 触发反爬
const BAIDU_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const BAIDU_LINK_PREFIX = 'http://www.baidu.com/link?url=';

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

export async function searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 0;

    while (allResults.length < limit) {
        const response = await axios.get('https://www.baidu.com/s', buildAxiosRequestOptions({ engine: 'baidu',
            trustedStaticHost: true,
            params: {
                wd: query,
                pn: pn.toString(),
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
        const results: SearchResult[] = [];

        const elements = $('#content_left').children().toArray();
        for (const element of elements) {
            const titleElement = $(element).find('h3');
            const linkElement = $(element).find('a');
            const snippetElement = $(element).find('.cos-row').first();

            if (titleElement.length && linkElement.length) {
                const href = linkElement.attr('href');
                if (href && href.startsWith('http')) {
                    const snippetElementBaidu = $(element).find('.c-font-normal.c-color-text').first();
                    const sourceElement = $(element).find('.cosc-source');
                    results.push({
                        title: titleElement.text(),
                        // 先解析跳转链拿真实 URL；解析失败则保留原链接
                        url: await resolveBaiduRedirectUrl(href),
                        description: snippetElementBaidu.attr('aria-label') || snippetElement.text().trim() || '',
                        source: sourceElement.text().trim() || '',
                        engine: 'baidu'
                    });
                }
            }
        }

        allResults = allResults.concat(results);

        if (results.length === 0) {
            console.error('⚠️ No more results, ending early....');
            break;
        }

        pn += 10;
    }

    return allResults.slice(0, limit); // 截取最多 limit 个
}
