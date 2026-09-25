import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { paginateSearch } from '../../utils/pagination.js';
import { createWreqSession, loadWreqModule, WreqSession } from '../bing/impersonate.js';
import { toAxiosLikeResponse } from '../../utils/wreqRequest.js';

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

const CSDN_SEARCH_API = 'https://so.csdn.net/api/v3/search';

/** 首屏"合法但为空"时重试前等待（给 WAF 软降级留出恢复窗口） */
const EMPTY_FIRST_PAGE_RETRY_DELAY_MS = 300;

/**
 * CSDN 的请求层（wreq-js Chrome TLS/HTTP2 指纹 + 会话 cookie 池，axios 兜底）。
 *
 * CSDN 搜索接口位于阿里云 WAF 之后（响应头 `server: WAF`），会对"三无"裸请求做软降级。
 * 会话级复用的两点价值：① TLS/HTTP2 指纹不像 Node 原生 TLS 那样自带爬虫特征；
 * ② wreq 的 Session 自带 cookie 池，首次响应下发的 `https_waf_cookie`
 *    （阿里云 WAF 令牌）会被自动保存并在后续请求带上，而不是每次都当新会话。
 * 真实前端还带 `Referer: https://so.csdn.net/so/search?q=...`，这里补齐；
 * UA 等头交给 wreq 的 browser profile 注入（与指纹保持一致），不手塞第二个 UA。
 */
let csdnWreqSessionPromise: Promise<WreqSession | null> | null = null;

async function ensureCsdnWreqSession(): Promise<WreqSession | null> {
    if (!csdnWreqSessionPromise) {
        csdnWreqSessionPromise = (async () => {
            const mod = await loadWreqModule();
            if (!mod) {
                return null;
            }
            try {
                return await createWreqSession(mod as unknown as Parameters<typeof createWreqSession>[0], 'csdn');
            } catch (error) {
                console.warn('CSDN wreq session creation failed, falling back to axios:', error instanceof Error ? error.message : String(error));
                return null;
            }
        })();
    }
    return csdnWreqSessionPromise;
}

/** 指纹优先的 GET：wreq 不可用/网络层失败时回退 axios（HTTP 状态错误直接抛出，不回退） */
async function csdnHttpGetWithImpersonate(url: string, options: AxiosRequestConfig): Promise<AxiosResponse> {
    const session = await ensureCsdnWreqSession();
    if (!session) {
        throw new Error('wreq session unavailable');
    }
    const response = await session.fetch(url, {
        timeout: (options.timeout as number) || 15000,
        headers: (options.headers as Record<string, string> | undefined)
    });
    if (response.status >= 400) {
        // 与 axios 一致：非 2xx 抛错，错误上带 response.status（供上层重试/熔断判定）
        const error = new Error(`Request failed with status code ${response.status}`);
        (error as { response?: { status: number } }).response = { status: response.status };
        throw error;
    }
    return toAxiosLikeResponse(response.status, response.headers, await response.text(), options);
}

const defaultCsdnHttpGet = async (url: string, options: AxiosRequestConfig): Promise<AxiosResponse> => {
    try {
        return await csdnHttpGetWithImpersonate(url, options);
    } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (typeof status === 'number') {
            throw error;
        }
        console.warn('CSDN impersonate request failed, falling back to axios:', error instanceof Error ? error.message : String(error));
        return axios.get(url, options);
    }
};

let csdnHttpGet: typeof defaultCsdnHttpGet = defaultCsdnHttpGet;

export function __setCsdnHttpGetForTests(impl?: typeof defaultCsdnHttpGet): void {
    csdnHttpGet = impl ?? defaultCsdnHttpGet;
}

/** wreq 路径拿到的是原始文本，axios 路径已解析过 JSON——统一在这里归一 */
function normalizeCsdnPayload(data: unknown): unknown {
    if (typeof data !== 'string') {
        return data;
    }
    try {
        return JSON.parse(data);
    } catch {
        return data;
    }
}

function buildCsdnSearchUrl(query: string, page: number): string {
    const url = new URL(CSDN_SEARCH_API);
    url.searchParams.set('q', query);
    url.searchParams.set('p', String(page));
    // t=blog：只召回技术博文，避开 download.csdn.net 资源包
    // （实测：30 条里 download 从 1 条降为 0 条；下载站内容正文价值低，
    //  且被下面的过滤规则剔除后会白白消耗配额）
    url.searchParams.set('t', 'blog');
    // platform=pc：与前端保持一致的平台参数（来自第三方审计报告，未独立抓包核验；实测带上后召回不变）
    url.searchParams.set('platform', 'pc');
    return url.toString();
}

function buildCsdnRequestOptions(query: string): AxiosRequestConfig {
    return buildAxiosRequestOptions({
        engine: 'csdn',
        trustedStaticHost: true,
        timeout: 15000,
        headers: {
            'Accept': 'application/json, text/plain, */*',
            // 补齐真实前端从搜索页发起该 API 时会带的 Referer（缺失可能被 WAF 视为非浏览器请求；此为防御性补齐，未独立抓包核验）
            'Referer': `https://so.csdn.net/so/search?q=${encodeURIComponent(query)}&t=blog`,
            // wreq 路径由指纹 profile 注入 UA，这个头只在 axios 回退路径生效
            'User-Agent': BROWSER_USER_AGENT
        }
    });
}

/**
 * 判断 CSDN 响应是否为"结构合法但零结果"。
 *
 * 实测（2026-09-25，本机直连）：冷门词真 0 结果响应为 **613 字节**
 * （`total: 0` + `result_vos: []`），正常词 128KB/30 条——两者只差结果本身。
 * 历史判据 `rawLength < 1000 && result_vos.length === 0` 因此把所有冷门词的真 0 结果
 * 误判成"限流空壳"并抛错（还会触发 3 次重试 + partialFailures 谎报故障）。
 * 现在改判 **`total` 与结果自相矛盾** 才是异常：`total > 0` 却一条不给。
 */
function isEmptyButTotalClaimed(payload: unknown): boolean {
    if (typeof payload !== 'object' || payload === null) {
        return false;
    }
    const { result_vos, total } = payload as { result_vos?: unknown; total?: unknown };
    return Array.isArray(result_vos) && result_vos.length === 0 && typeof total === 'number' && total > 0;
}

async function fetchCsdnPage(query: string, page: number): Promise<unknown> {
    const url = buildCsdnSearchUrl(query, page);
    const options = buildCsdnRequestOptions(query);
    const first = normalizeCsdnPayload((await csdnHttpGet(url, options)).data);

    // 首屏空 → 用同一会话带 cookie 重试一次：既覆盖"WAF 对首个无 cookie 请求软降级"，
    // 也让冷门词的真 0 结果走正常返回路径（实测：这类空响应重试后依然是合法的 total=0）
    if (page === 1 && typeof first === 'object' && first !== null) {
        const { result_vos } = first as { result_vos?: unknown };
        if (Array.isArray(result_vos) && result_vos.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, EMPTY_FIRST_PAGE_RETRY_DELAY_MS));
            const retry = normalizeCsdnPayload((await csdnHttpGet(url, options)).data);
            const retryVos = (retry as { result_vos?: unknown })?.result_vos;
            if (Array.isArray(retryVos) && retryVos.length > 0) {
                return retry;
            }
            // 重试仍是空：total>0 说明上游声称有结果却一条不给（真实异常，显式报错）；
            // total=0 则是该词确实无结果，正常返回空数组
            if (isEmptyButTotalClaimed(retry) || isEmptyButTotalClaimed(first)) {
                throw new Error('CSDN returned an empty response with total > 0 (likely rate-limited or throttled)');
            }
        }
    }

    return first;
}

export async function searchCsdn(query: string, limit: number): Promise<SearchResult[]> {
    const seenUrls = new Set<string>();

    return paginateSearch({
        limit,
        fetchPage: async (pageIndex) => {
            const pn = pageIndex + 1;
            const payload = await fetchCsdnPage(query, pn);

            // 反爬/异常时 CSDN 可能返回 HTML 文本而非 JSON：直接解构会得到 undefined 并静默 break，
            // 首页失败应抛错，让 partialFailures 暴露真实原因（而非伪装成"没有结果"）
            if (typeof payload !== 'object' || payload === null) {
                if (pn === 1) {
                    throw new Error('CSDN search returned a non-JSON response (likely blocked or rate-limited)');
                }
                return [];
            }
            const { result_vos } = payload as { result_vos?: unknown };
            if (!Array.isArray(result_vos)) {
                if (pn === 1) {
                    throw new Error('CSDN search response missing result_vos (likely blocked or rate-limited)');
                }
                return [];
            }

            return parseCsdnResults(result_vos as never, seenUrls);
        }
    });
}
