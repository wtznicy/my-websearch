import axios from 'axios';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { paginateSearch } from '../../utils/pagination.js';

/** CSDN 搜索结果里的 <em> 高亮标签，剥离后返回纯文本 */
export function stripHighlightTags(value: string): string {
    if (!value) {
        return '';
    }
    return String(value).replace(/<\/?em>/g, '').trim();
}

/**
 * 把 CSDN 搜索 API 的一页 result_vos 映射为 SearchResult（页内按 URL 去重）。
 * 过滤低价值下载资源页（download.csdn.net，正文价值低）与无信息量条目（无标题或无摘要）。
 */
export function parseCsdnResults(
    resultVos: Array<{ digest: string; title: string; url_location: string; nickname: string }>,
    seenUrls: Set<string>
): SearchResult[] {
    const results: SearchResult[] = [];
    for (const re of resultVos) {
        const { digest, title, url_location, nickname } = re;
        const url = url_location || '';
        if (!url || seenUrls.has(url) || /^https?:\/\/download\.csdn\.net\//i.test(url)) {
            continue;
        }
        const cleanTitle = stripHighlightTags(title);
        const cleanDigest = stripHighlightTags(digest);
        // 无标题或无摘要的条目对 LLM 无信息量（常见于广告/空壳页），剔除
        if (!cleanTitle || !cleanDigest) {
            continue;
        }
        seenUrls.add(url);
        results.push({
            title: cleanTitle,
            url,
            description: cleanDigest,
            source: nickname || '',
            engine: 'csdn'
        });
    }
    return results;
}

export async function searchCsdn(query: string, limit: number): Promise<SearchResult[]> {
    const seenUrls = new Set<string>();

    return paginateSearch({
        limit,
        fetchPage: async (pageIndex) => {
            const pn = pageIndex + 1;
            const response = await axios.get('https://so.csdn.net/api/v3/search', buildAxiosRequestOptions({ engine: 'csdn',
                trustedStaticHost: true,
                params: {
                    q: query,
                    p: pn
                },
                headers: {
                    'Pragma': 'no-cache',
                    // 不再硬编码会话 Cookie（含 waf_captcha_marker 等抓包痕迹，会过期且属轻微凭据泄漏），
                    // 让服务端为新会话发 Cookie；UA 用与其它引擎一致的现代浏览器
                    'User-Agent': BROWSER_USER_AGENT,
                    'Accept': '*/*',
                    'Connection': 'keep-alive'
                }
            }));

            const payload = response.data;
            // 反爬/异常时 CSDN 可能返回 HTML 文本而非 JSON：直接解构会得到 undefined 并静默 break，
            // 首页失败应抛错，让 partialFailures 暴露真实原因（而非伪装成"没有结果"）
            if (typeof payload !== 'object' || payload === null) {
                if (pn === 1) {
                    throw new Error('CSDN search returned a non-JSON response (likely blocked or rate-limited)');
                }
                return [];
            }
            const { result_vos } = payload;
            if (!Array.isArray(result_vos)) {
                if (pn === 1) {
                    throw new Error('CSDN search response missing result_vos (likely blocked or rate-limited)');
                }
                return [];
            }

            const results = parseCsdnResults(payload.result_vos, seenUrls);

            return results;
        }
    });
}
