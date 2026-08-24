import axios from 'axios';
import * as cheerio from 'cheerio';
import {SearchResult} from "../../types.js";
import {buildAxiosRequestOptions} from "../../utils/httpRequest.js";
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { assertOverseasEngineUsable } from '../../utils/overseasProbe.js';

export function isTrustedDuckDuckGoPreloadUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'links.duckduckgo.com'
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/d.js';
  } catch {
    return false;
  }
}

/**
 * preload 路径（JSONP）返回的 title/description/source 是 HTML 片段：
 * 含 <b> 高亮标签和 &#x27; 等实体（如 "<b>MCP</b> is... Whether you&#x27;re"），
 * 统一转纯文本（剥标签 + 解码实体），与 HTML 路径的 cheerio .text() 结果保持一致。
 */
function cleanHighlightedText(html: string): string {
  if (!html) {
    return '';
  }
  return cheerio.load(html).root().text().trim();
}

/**
 * 解析 DuckDuckGo preload 路径（links.duckduckgo.com/d.js）返回的 JSONP 文本。
 * 提取并映射为 SearchResult；导航项（item.n）跳过。文本不可解析时返回空数组
 * （由调用方决定终止分页）。
 */
export function parseDuckDuckGoJsonpPayload(jsonpText: string): SearchResult[] {
  const jsonpMatch = jsonpText.match(/DDG\.pageLayout\.load\('d',\s*(\[.*?\])\s*\);/s);
  if (!jsonpMatch || !jsonpMatch[1]) {
    return [];
  }

  try {
    const jsonData = JSON.parse(jsonpMatch[1]);
    const results: SearchResult[] = [];
    jsonData.forEach((item: any) => {
      // Exclude navigation items
      if (item.n) {
        return;
      }
      results.push({
        title: cleanHighlightedText(item.t || ''),
        url: item.u || '',
        description: cleanHighlightedText(item.a || ''),
        source: cleanHighlightedText(item.i || item.sn || ''),
        engine: 'duckduckgo'
      });
    });
    return results;
  } catch (error) {
    console.warn('解析JSONP数据失败:', error);
    return [];
  }
}

export type DuckDuckGoHtmlParseResult = {
  results: SearchResult[];
  /** 本页原始结果卡数量（含广告/被过滤项），用于分页 offset 计算 */
  rawCount: number;
};

/**
 * 解析 DuckDuckGo HTML 路径（html.duckduckgo.com/html/）的结果页。
 * 广告卡（.result--ad）与已见 URL 会被过滤；rawCount 供调用方计算下一页 offset。
 */
export function parseDuckDuckGoHtmlResults(html: string, maxResults: number, seenUrls: Set<string>): DuckDuckGoHtmlParseResult {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  let rawCount = 0;

  $('div.result').each((_, el) => {
    rawCount += 1;
    if (results.length >= maxResults) {
      return false;
    }

    const titleEl = $(el).find('a.result__a');
    const snippetEl = $(el).find('.result__snippet');
    const title = titleEl.text().trim();
    const url = titleEl.attr('href') || '';
    const description = snippetEl.text().trim();
    const sourceEl = $(el).find('.result__url');
    const source = sourceEl.text().trim();

    if (title && url && !$(el).hasClass('result--ad') && !seenUrls.has(url)) {
      seenUrls.add(url);
      results.push({
        title,
        url,
        description,
        source,
        engine: 'duckduckgo'
      });
    }
  });

  return { results, rawCount };
}


/**
 * Search DuckDuckGo and return results
 * @param query Search query
 * @param limit Maximum number of results
 * @returns Array of search results
 */
export async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  // 未配置代理时先探测直连可达性：不可达立即报"需要代理"，避免直连挂 15s 超时拖累整次搜索
  await assertOverseasEngineUsable('duckduckgo');
  // Try using the preloaded URL method
  try {
    const results = await searchDuckDuckGoPreloadUrl(query, limit);
    if (results.length > 0) {
      return results;
    }
  } catch (error) {
    console.warn('预加载URL方法失败，尝试HTML方法:', error instanceof Error ? error.message : String(error));
  }

  return await searchDuckDuckGoHtml(query, limit);
  }

  /**
  * Extract preloaded d.js URL from DuckDuckGo search page and use it directly
  */
  async function searchDuckDuckGoPreloadUrl(query: string, maxResults = 10): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    let offset = 0;

    try {
      // Configure request options
      const requestOptions = buildAxiosRequestOptions({ engine: 'duckduckgo',
        trustedStaticHost: true,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Connection": "keep-alive",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          "sec-ch-ua": "\"Chromium\";v=\"112\", \"Google Chrome\";v=\"112\", \"Not:A-Brand\";v=\"99\"",
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": "\"Windows\"",
          "upgrade-insecure-requests": "1",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-user": "?1",
          "sec-fetch-dest": "document",
          "referer": "https://duckduckgo.com/",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
      });

      const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=h_&ia=web`;
      const response = await axios.get(searchUrl, requestOptions);

      let basePreloadUrl = '';

      // Method 1: Use cheerio to find preload links
      const $ = cheerio.load(response.data);
      $('link[rel="preload"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && isTrustedDuckDuckGoPreloadUrl(href)) {
          basePreloadUrl = href;
          return false; // 停止循环
        }
      });

      // Method 2: If preload link not found, try to get from script tag
      if (!basePreloadUrl) {
        $('#deep_preload_script').each((_, el) => {
          const src = $(el).attr('src');
          if (src && isTrustedDuckDuckGoPreloadUrl(src)) {
            basePreloadUrl = src;
            return false;
          }
        });
      }

      // Method 3: Use regex to extract from entire HTML
      if (!basePreloadUrl) {
        const urlMatch = response.data.match(/https:\/\/links\.duckduckgo\.com\/d\.js\?[^"']+/i);
        if (urlMatch && isTrustedDuckDuckGoPreloadUrl(urlMatch[0])) {
          basePreloadUrl = urlMatch[0];
        }
      }

      if (!basePreloadUrl) {
        console.warn('无法找到预加载的d.js URL');
        return [];
      }

      // Create URL object to easily modify parameters
      const preloadUrlObj = new URL(basePreloadUrl);

      // Loop to get results from all pages until maxResults is satisfied or no more results
      let hasMoreResults = true;

      while (results.length < maxResults && hasMoreResults) {
        // Update s parameter (offset)
        preloadUrlObj.searchParams.set('s', offset.toString());

        // Get current page results
        const currentPageUrl = preloadUrlObj.toString();

        // Request search results using current page URL
        const dataResponse = await axios.get(currentPageUrl, {
          ...requestOptions,
          headers: {
            "User-Agent": BROWSER_USER_AGENT,
            "Connection": "keep-alive",
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": "\"Chromium\";v=\"112\", \"Google Chrome\";v=\"112\", \"Not:A-Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-site": "same-site",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-dest": "script",
            "referer": "https://duckduckgo.com/",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
          }
        });

        // Extract JSON data from JSONP response
        const pageResults = parseDuckDuckGoJsonpPayload(String(dataResponse.data || ''));

        // If no results, means no more data
        if (pageResults.length === 0) {
          hasMoreResults = false;
          break;
        }

        // Calculate next page offset (current offset + current page results)
        let validResultsInCurrentPage = 0;

        // Process search results
        for (const result of pageResults) {
          validResultsInCurrentPage++;
          // If results already meet requirements, don't add more
          if (results.length >= maxResults) {
            break;
          }
          results.push(result);
        }

        // Update offset, prepare to request next page
        offset += validResultsInCurrentPage;
      }

      return results.slice(0, maxResults);
    } catch (error) {
      // 不要静默吞成"0 结果"：re-throw 让主入口 fallback 到 HTML 路径，
      // 若 HTML 也失败，真实原因（网络/限流/解析）能通过 partialFailures 暴露出来
      console.error('DuckDuckGo预加载URL搜索失败:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function searchDuckDuckGoHtml(query: string, maxResults = 10): Promise<SearchResult[]> {
  const requestUrl = 'https://html.duckduckgo.com/html/';

    // Configure request options
    const requestOptions = buildAxiosRequestOptions({ engine: 'duckduckgo',
    trustedStaticHost: true,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_USER_AGENT,
      'Accept': '*/*',
      'Connection': 'keep-alive'
    },
  });

  try {
    const seenUrls = new Set<string>();
    const results: SearchResult[] = [];
    let offset = 0;
    let pageCount = 0;

    let response = await axios.post(
      requestUrl,
      new URLSearchParams({ q: query }).toString(),
      requestOptions
    );

    let parsedPage = parseDuckDuckGoHtmlResults(String(response.data || ''), maxResults, seenUrls);
    results.push(...parsedPage.results);

    while (results.length < maxResults && parsedPage.rawCount > 0 && pageCount < 10) {
      offset += parsedPage.rawCount;
      pageCount += 1;

      // 记录本页 URL 集合，用于检测服务端重复返回导致的无进展死循环
      const beforeDedup = results.length;

      response = await axios.post(
        requestUrl,
        new URLSearchParams({
          q: query,
          s: offset.toString(),
          dc: offset.toString(),
          v: 'l',
          o: 'json',
          api: 'd.js'
        }).toString(),
        requestOptions
      );

      parsedPage = parseDuckDuckGoHtmlResults(String(response.data || ''), maxResults, seenUrls);
      results.push(...parsedPage.results);

      // 安全阀：本页没有新增任何去重后的结果，说明分页无进展，终止循环避免死循环
      if (results.length === beforeDedup) {
        console.warn('⚠️ DuckDuckGo pagination made no progress, stopping to avoid infinite loop');
        break;
      }
    }

    return results.slice(0, maxResults);
  } catch (error) {
    console.error('DuckDuckGo HTML search failed:', error instanceof Error ? error.message : String(error));
    // 向上抛错，由 searchService 的重试 + partialFailures 机制接管
    throw error;
  }
}
