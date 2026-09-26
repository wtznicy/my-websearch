import axios from 'axios';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { BROWSER_USER_AGENT as BAIDU_USER_AGENT } from '../../utils/constants.js';
import { paginateSearch } from '../../utils/pagination.js';
import { isImpersonateAvailable, searchBaiduWithImpersonate } from './impersonate.js';
import { isBaiduAntiBotPage, parseBaiduResultsPage } from './parser.js';

const BAIDU_ANTIBOT_MESSAGE = 'Baidu returned an anti-bot or redirect page (likely missing cookies or verification)';

/** 把"反爬/跳转验证"统一成一条可识别的错误：不可重试（秒级重试必然失败，只会白耗搜索预算） */
function buildBaiduAntiBotError(detail?: string): Error {
    const error = new Error(detail ? `${BAIDU_ANTIBOT_MESSAGE} [${detail}]` : BAIDU_ANTIBOT_MESSAGE);
    (error as { retryable?: boolean }).retryable = false;
    return error;
}

/** 3xx 跳转（百度把无 cookie/被限流的请求 302 到验证页）在这条链路上等价于反爬 */
function isRedirectStatus(status: unknown): boolean {
    return typeof status === 'number' && status >= 300 && status < 400;
}

export async function searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
    // 首选 wreq-js 指纹请求（Chrome TLS/HTTP2 指纹 + 会话 cookie），规避纯 HTTP
    // 无 cookie 被重定向到安全验证页的问题；原生模块不可用或请求失败时回退到
    // axios 路径，不影响现有行为。
    if (await isImpersonateAvailable()) {
        try {
            return await searchBaiduWithImpersonate(query, limit);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isAntiBot = /anti-bot|redirect page/i.test(message);
            if (isAntiBot) {
                // 指纹请求（Chrome TLS + 会话 Cookie）已被百度判定为反爬时，
                // 严禁再用 axios（裸 OpenSSL TLS、无 Cookie）兜底发起请求！
                // 裸请求不仅 100% 会触发 302，而且会加速该 IP 的封禁；
                // 立即抛出不可重试的反爬错误，交由 minResults 级联换其他国内引擎（Bing/CSDN/搜狗）补齐。
                throw buildBaiduAntiBotError(message);
            }
            console.warn('Baidu impersonate request failed, falling back to axios:', message);
        }
    }

    const seenUrls = new Set<string>();

    try {
        return await paginateSearch({
            limit,
            fetchPage: async (pageIndex) => {
                let response;
                try {
                    response = await axios.get('https://www.baidu.com/s', buildAxiosRequestOptions({ engine: 'baidu',
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
                } catch (error) {
                    // 302 是百度最常见的反爬形态（把请求跳去验证页）；此处转成显式、不可重试的反爬错误，
                    // 让 partialFailures 显示"被反爬"而不是裸的 `Request failed with status code 302`
                    const status = (error as { response?: { status?: number } })?.response?.status;
                    if (isRedirectStatus(status)) {
                        throw buildBaiduAntiBotError(`HTTP ${status} redirect`);
                    }
                    throw error;
                }

                const html = String(response.data || '');
                // 反爬显式抛错（而非静默返回空结果），让 partialFailures/多引擎级联暴露真实原因
                if (isBaiduAntiBotPage(html)) {
                    throw buildBaiduAntiBotError();
                }

                return parseBaiduResultsPage(html, seenUrls);
            }
        });
    } catch (error) {
        throw error;
    }
}
