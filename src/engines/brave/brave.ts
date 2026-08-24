import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from "../../utils/httpRequest.js";
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { paginateSearch } from '../../utils/pagination.js';
import { assertOverseasEngineUsable } from '../../utils/overseasProbe.js';

/** Brave 拦截/验证页的标题关键词（反爬时页面 title 变为这些） */
const BRAVE_BLOCKED_TITLE_KEYWORDS = [
    'access denied',
    'unusual traffic',
    'verify you are human',
    'captcha',
    'request blocked',
    '访问被拒绝',
    '人机验证'
];

/** 判断 Brave 返回的是拦截/验证页（而非结果页） */
function isBraveBlockedPage(html: string): boolean {
    const title = cheerio.load(html)('title').first().text().trim().toLowerCase();
    return BRAVE_BLOCKED_TITLE_KEYWORDS.some((keyword) => title.includes(keyword));
}

/** Brave 对数据中心/代理 IP 限流（429）时给出明确提示，而非笼统的 status code 错误 */
function buildBraveErrorMessage(error: unknown): Error {
    const status = (error as any)?.response?.status;
    if (status === 429) {
        return new Error(
            'Brave rate limited (HTTP 429): the proxy/datacenter IP is throttled by Brave. ' +
            'Retry later, reduce search frequency, or use another engine (e.g. duckduckgo/startpage).'
        );
    }
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * 解析 Brave 结果页（SvelteKit SSR）。
 * 结果卡结构：
 * .snippet[.svelte-*]（新版外层容器已不带 #results 锚点，选择器必须兼容两种结构）
 *   └── .result-content
 *        ├── > a (main link with href)
 *        │   ├── .site-name-wrapper (source)
 *        │   └── .search-snippet-title (title)
 *        └── .generic-snippet (description)
 */
export function parseBraveResults(html: string, seenUrls: Set<string>): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $('#results .snippet, .snippet').each((_, element) => {
        const resultElement = $(element);
        const content = resultElement.find('.result-content').first();
        if (content.length === 0) return;

        // The first <a> inside .result-content is the main link
        const mainLink = content.find('> a').first();
        const url = mainLink.attr('href');

        // Title is inside .search-snippet-title
        const title = mainLink.find('.search-snippet-title').text().trim();

        // Description is in .generic-snippet
        const description = content.find('.generic-snippet').text().trim() || '';

        // Source/site name is in .site-name-wrapper
        const source = mainLink.find('.site-name-wrapper').first().text().trim() || '';

        // Ensure that we have a valid title and URL before adding
        if (title && url && !seenUrls.has(url)) {
            seenUrls.add(url);
            results.push({
                title: title,
                url: url,
                description: description,
                source: source,
                engine: 'brave'
            });
        }
    });

    return results;
}

export async function searchBrave(query: string, limit: number): Promise<SearchResult[]> {
  // 未配置代理时先探测直连可达性：不可达立即报"需要代理"，避免直连挂超时拖累整次搜索
  await assertOverseasEngineUsable('brave');
  const seenUrls = new Set<string>();
    const encodedQuery = encodeURIComponent(query);
    const requestOptions = buildAxiosRequestOptions({ engine: 'brave',
        trustedStaticHost: true,
        headers: {
            "User-Agent": BROWSER_USER_AGENT,
            "Connection": "keep-alive",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": "\"Chromium\";v=\"133\", \"Google Chrome\";v=\"133\", \"Not:A-Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "upgrade-insecure-requests": "1",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "navigate",
            "sec-fetch-user": "?1",
            "sec-fetch-dest": "document",
            "referer": "https://search.brave.com/",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
    });

    return paginateSearch({
        limit,
        fetchPage: async (pageIndex) => {
            let response;
            try {
                response = await axios.get(`https://search.brave.com/search?q=${encodedQuery}&source=web&offset=${pageIndex}`, requestOptions);
            } catch (error) {
                throw buildBraveErrorMessage(error);
            }

            // 反爬/拦截页检测：命中时抛明确错误（不再静默返回 0 条伪装成"没有结果"）
            if (isBraveBlockedPage(String(response.data || ''))) {
                throw new Error('Brave returned a verification or anti-bot page (access denied / captcha)');
            }

            return parseBraveResults(String(response.data || ''), seenUrls);
        }
    });
}
