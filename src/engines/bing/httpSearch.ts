import axios from 'axios';
import * as cheerio from 'cheerio';
import { AppError, extractErrorStatus, isAbortedError, isCascadeAbortedError } from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';
import { EngineSearchResponse, SearchResult } from '../../types.js';
import { analyzeBlockedPage, buildBingAxiosRequestOptions } from './blockedPage.js';
import {
    buildBingSearchUrl,
    extractSiteDomains,
    getEffectiveBingBaseUrl,
    matchesSiteDomains,
    setEffectiveBingBaseUrl
} from './query.js';
import { isBingImpersonateCircuitOpen, isImpersonateAvailable, searchBingWithImpersonate } from './impersonate.js';
import { parseBingSearchResults } from './parser.js';

export function isBingRedirectError(error: unknown): boolean {
    const status = extractErrorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    return status === 301 || status === 302 || /status code (?:301|302)/i.test(message) || /redirect/i.test(message);
}

export function applySiteDomainFilter(results: EngineSearchResponse, query: string): EngineSearchResponse {
    const siteDomains = extractSiteDomains(query);
    if (siteDomains.length === 0 || results.length === 0) {
        return results;
    }
    const filtered = results.filter((result) => matchesSiteDomains(result.url, siteDomains)) as EngineSearchResponse;
    if (results.directAnswer) {
        filtered.directAnswer = results.directAnswer;
    }
    if (filtered.length === 0) {
        throw new AppError({
            code: 'engine_parse_error',
            retryable: false,
            engine: 'bing',
            hint: 'Bing HTTP ignored the site: operator; falling back to Playwright or cascade engines.',
            message: `Bing HTTP results did not match site:${siteDomains.join(',')} (site: operator ignored by cn.bing HTTP)`
        });
    }
    return filtered;
}

export async function searchBingWithHttp(query: string, limit: number, signal?: AbortSignal, timeRange?: 'day' | 'week' | 'month' | 'year'): Promise<SearchResult[]> {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', engine: 'bing', message: 'Bing HTTP search aborted', retryable: false });
    }
    // 首选 wreq-js 指纹请求（Chrome TLS/HTTP2 指纹模拟，规避纯 HTTP 请求被软降级为无关结果）；
    // 原生模块不可用、连续 0 条已熔断、或请求失败时回退到 axios 路径。
    let impersonateResults: EngineSearchResponse | undefined;
    if (!isBingImpersonateCircuitOpen() && await isImpersonateAvailable()) {
        try {
            impersonateResults = await searchBingWithImpersonate(query, limit, signal, timeRange);
        } catch (error) {
            if (signal?.aborted || isAbortedError(error)) {
                if (isCascadeAbortedError(error)) {
                    metrics.debug('bing.impersonate.cascade_aborted', { engine: 'bing' });
                }
                throw error;
            }
            console.warn('Bing impersonate request failed, falling back to axios:', error instanceof Error ? error.message : String(error));
        }
    }
    if (impersonateResults && impersonateResults.length > 0) {
        return applySiteDomainFilter(impersonateResults, query);
    }
    if (impersonateResults && impersonateResults.length === 0) {
        console.warn('Bing impersonate returned 0 results; falling back to axios HTTP path');
    }

    let allResults: SearchResult[] = [];
    let directAnswer: string | undefined;
    let pageNumber = 0;

    while (allResults.length < limit) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new AppError({ code: 'aborted', engine: 'bing', message: 'Bing HTTP search aborted', retryable: false });
        }
        let response: import('axios').AxiosResponse;
        let currentBaseUrl = getEffectiveBingBaseUrl();
        try {
            response = await axios.get(buildBingSearchUrl(query, pageNumber, timeRange, currentBaseUrl), buildBingAxiosRequestOptions(signal));
        } catch (pageError) {
            // cn.bing.com 在境外节点/代理下会被微软 301 永久重定向到 www.bing.com，导致 maxRedirects:0 抛错；
            // 此时以纯 HTTP 优雅降级为 www.bing.com/search 极速重试，毫秒级直接拿结果，无需进入重型 CDP 浏览器
            if (isBingRedirectError(pageError) && currentBaseUrl.includes('cn.bing.com')) {
                console.warn('cn.bing.com returned 301/302 redirect; automatically falling back to www.bing.com/search via HTTP');
                currentBaseUrl = 'https://www.bing.com/search';
                setEffectiveBingBaseUrl(currentBaseUrl);
                try {
                    response = await axios.get(buildBingSearchUrl(query, pageNumber, timeRange, currentBaseUrl), buildBingAxiosRequestOptions(signal));
                } catch (retryError) {
                    if (pageNumber > 0 && allResults.length > 0) {
                        break;
                    }
                    throw retryError;
                }
            } else {
                if (pageNumber > 0 && allResults.length > 0) {
                    console.warn(`Bing pagination page ${pageNumber} failed, gracefully returning ${allResults.length} partial results:`, pageError instanceof Error ? pageError.message : String(pageError));
                    break;
                }
                throw pageError;
            }
        }
        const html = String(response.data || '');
        const $ = cheerio.load(html);

        const pageState = analyzeBlockedPage($, html);
        if (pageState.blocked) {
            throw new AppError({
                code: 'bot_challenge',
                retryable: false,
                engine: 'bing',
                message: `Bing returned a verification or anti-bot page (title: ${pageState.title || 'unknown'}, keywords: ${pageState.detectedKeywords.join(', ') || 'none'})`
            });
        }
        if (pageState.hasResults && pageState.detectedKeywords.length > 0) {
            console.warn(`Bing page contains suspicious keywords but also has results, skipping block detection: ${pageState.detectedKeywords.join(', ')}`);
        }

        const results = parseBingSearchResults(html, limit - allResults.length, $);
        if (!directAnswer && results.directAnswer) {
            directAnswer = results.directAnswer;
        }
        allResults = allResults.concat(results);

        if (results.length === 0) {
            if (pageNumber === 0 && allResults.length === 0) {
                if (pageState.isNoResults) {
                    break;
                }
                throw new AppError({
                    code: 'bot_challenge',
                    retryable: false,
                    engine: 'bing',
                    message: 'Bing HTTP mode returned 0 results (possible anti-bot layout change or verification)'
                });
            }
            console.error('⚠️ No more Bing results from HTTP mode, ending early.');
            break;
        }

        pageNumber += 1;
    }

    const httpResults = allResults.slice(0, limit) as EngineSearchResponse;
    if (directAnswer) {
        httpResults.directAnswer = directAnswer;
    }
    return applySiteDomainFilter(httpResults, query);
}

/**
 * 当常规 HTTP 请求命中首词漂移时（例如纯英文多词在 cn.bing 下只匹配第一个词），
 * 优先在 HTTP 内部做极速纠偏重试（Fast Drift Recovery）：
 * 尝试通过国际版端点 (https://www.bing.com/search) 或英文参数重试，
 * 耗时仅数百毫秒；纠偏成功则无需唤醒庞大且耗时数秒的 CDP 浏览器。
 */
export async function recoverBingDriftWithHttp(
    query: string,
    limit: number,
    signal?: AbortSignal,
    timeRange?: 'day' | 'week' | 'month' | 'year'
): Promise<EngineSearchResponse | undefined> {
    if (signal?.aborted) {
        return undefined;
    }
    const currentBaseUrl = getEffectiveBingBaseUrl();
    const recoveryBaseUrl = currentBaseUrl.includes('cn.bing.com')
        ? 'https://www.bing.com/search'
        : currentBaseUrl;

    // 1. 若 wreq 可用，优先走 wreq 指纹的国际版极速重试
    if (!isBingImpersonateCircuitOpen() && await isImpersonateAvailable()) {
        try {
            const recovered = await searchBingWithImpersonate(query, limit, signal, timeRange, {
                customBaseUrl: recoveryBaseUrl,
                setLang: 'en-US'
            });
            if (recovered && recovered.length > 0) {
                return applySiteDomainFilter(recovered, query);
            }
        } catch {
            // wreq 快速纠偏失败，继续尝试 axios 兜底重试
        }
    }

    // 2. axios 路径快速纠偏重试
    try {
        const url = buildBingSearchUrl(query, 0, timeRange, recoveryBaseUrl, { setLang: 'en-US' });
        const response = await axios.get(url, buildBingAxiosRequestOptions(signal));
        const html = String(response.data || '');
        const results = parseBingSearchResults(html, limit);
        if (results && results.length > 0) {
            return applySiteDomainFilter(results, query);
        }
    } catch {
        // 快速纠偏失败，返回 undefined 交由外部 CDP 兜底
    }

    return undefined;
}
