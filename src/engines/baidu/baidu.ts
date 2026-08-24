import axios from 'axios';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { BROWSER_USER_AGENT as BAIDU_USER_AGENT } from '../../utils/constants.js';
import { paginateSearch } from '../../utils/pagination.js';
import { isImpersonateAvailable, searchBaiduWithImpersonate } from './impersonate.js';
import { isBaiduAntiBotPage, parseBaiduResultsPage } from './parser.js';

export async function searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
    // 首选 curl-cffi-node（Chrome TLS/HTTP2 指纹 + 会话 cookie），规避纯 HTTP
    // 无 cookie 被重定向到安全验证页的问题；原生模块不可用或请求失败时回退到
    // axios 路径，不影响现有行为。
    if (await isImpersonateAvailable()) {
        try {
            return await searchBaiduWithImpersonate(query, limit);
        } catch (error) {
            console.warn('Baidu impersonate request failed, falling back to axios:', error instanceof Error ? error.message : String(error));
        }
    }

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

            const html = String(response.data || '');
            // 反爬显式抛错（而非静默返回空结果），让 partialFailures/多引擎级联暴露真实原因
            if (isBaiduAntiBotPage(html)) {
                throw new Error('Baidu returned an anti-bot or redirect page (likely missing cookies or verification)');
            }

            return parseBaiduResultsPage(html, seenUrls);
        }
    });
}
