import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from "../../utils/httpRequest.js";
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { paginateSearch } from '../../utils/pagination.js';
import { assertOverseasEngineUsable } from '../../utils/overseasProbe.js';
import { tripEngineCircuit } from '../../core/search/engineCircuitBreaker.js';
import { impersonateHttpGet } from '../../utils/impersonateRequest.js';
import { isBraveBlockedPage } from '../../core/antiBot/antiBotDetection.js';
import { extractErrorStatus, markNonRetryable } from '../../core/errors.js';
export { isBraveBlockedPage };

const braveHttpGet = (url: string, options: AxiosRequestConfig): Promise<AxiosResponse> =>
    impersonateHttpGet('brave', url, options);

/** Brave 对数据中心/代理 IP 限流（429）时给出明确提示，而非笼统的 status code 错误 */
function buildBraveErrorMessage(error: unknown): Error {
    const status = extractErrorStatus(error);
    if (status === 429) {
        // 实测 429 来自 AWS CloudFront + WAF 的 IP 级限流（响应带 x-cache: Error from cloudfront）：
        // 被标记的出口 IP 在分钟级窗口内必然持续 429——标记不可重试（避免 3 次重试风暴浪费 5~8 秒）
        // 并熔断该引擎 5 分钟，让配额平移给其他引擎（见 engineCircuitBreaker）
        const err = markNonRetryable(new Error(
            'Brave rate limited (HTTP 429): the proxy/datacenter IP is throttled by Brave (CloudFront IP-level rate rule). ' +
            'Circuit opened for 5 minutes; quota reallocated to other engines. Retry later or use duckduckgo/startpage.'
        ));
        tripEngineCircuit('brave');
        return err;
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

        // 顶部商业推广卡（服务端注入的 JSON-LD "SearchResultAd"）：实测搜 'vue3' 时第 1 条
        // 是 booking.com 酒店广告，href 为相对跳转 /a/redirect?click_url=...（LLM 无法访问的坏链）。
        // 判据取自实测 DOM：广告卡带 data-type="ad" 且 id="search-ad"，正常结果为 data-type="web"。
        if (resultElement.attr('data-type') === 'ad' || resultElement.attr('id') === 'search-ad') {
            return;
        }
        // 只保留绝对 http(s) 链接：相对跳转（/a/redirect 等广告或站内跳转）对调用方无意义
        if (!url || !/^https?:\/\//i.test(url)) {
            return;
        }

        // Title is inside .search-snippet-title
        const title = mainLink.find('.search-snippet-title').text().trim();

        // Description is in .generic-snippet
        const description = content.find('.generic-snippet').text().trim() || '';

        // Source/site name is in .site-name-wrapper
        const rawSource = mainLink.find('.site-name-wrapper').first().text().trim() || '';

        // 统一 source 为纯域名（面包屑文本如 "cloud.google.com › discover › ..." 跨引擎格式不一致）；
        // URL 解析失败时回退原始面包屑文本
        let source = rawSource;
        if (url) {
            try {
                source = new URL(url).hostname;
            } catch {
                // 保留 rawSource
            }
        }

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
                response = await braveHttpGet(`https://search.brave.com/search?q=${encodedQuery}&source=web&offset=${pageIndex}`, requestOptions);
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
