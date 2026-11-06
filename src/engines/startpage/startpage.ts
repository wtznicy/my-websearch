import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AppConfig } from '../../config.js';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { assertOverseasEngineUsable } from '../../utils/overseasProbe.js';
import { warmupWithAnubisPow } from './anubisSolver.js';
import { AppError } from '../../core/errors.js';

const STARTPAGE_BASE_URL = 'https://www.startpage.com';
const STARTPAGE_SEARCH_URL = `${STARTPAGE_BASE_URL}/sp/search`;
const STARTPAGE_SC_TTL_MS = 30 * 60 * 1000;
/** Anubis PoW 会话的 TTL：放行 JWT 有效期 5 分钟，取 4 分钟保守值 */
const ANUBIS_SESSION_TTL_MS = 4 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 10;

import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';
const COMMON_HEADERS = {
    'User-Agent': DEFAULT_DESKTOP_UA,
    'Accept-Language': 'en-US,en;q=0.9'
};

let cachedScCode: string | undefined;
let cachedCookies: string | undefined;
let cachedScAt = 0;
/** 当前缓存的会话 TTL（PoW 会话 4 分钟 / 浏览器会话 30 分钟） */
let currentSessionTtlMs = STARTPAGE_SC_TTL_MS;

export function resetStartpageCache(): void {
    cachedScCode = undefined;
    cachedCookies = undefined;
    cachedScAt = 0;
    inflightScWarmupPromise = null;
}

import { isStartpageCaptchaPage } from '../../core/antiBot/antiBotDetection.js';
const isCaptchaPage = isStartpageCaptchaPage;

function extractScCode(html: string): string | undefined {
    const $ = cheerio.load(html);
    return $('form[action="/sp/search"] input[name="sc"]').first().attr('value')?.trim() || undefined;
}

function extractInterstitialPayload(html: string): Record<string, string> | undefined {
    const match = html.match(/var data = (\{[\s\S]*?\});/);
    const payloadJson = match?.[1];
    if (!payloadJson) {
        return undefined;
    }

    try {
        const payload = JSON.parse(payloadJson) as Record<string, unknown>;
        if (typeof payload?.query !== 'string' || typeof payload?.sgt !== 'string') {
            return undefined;
        }

        const data = Object.entries(payload).reduce<Record<string, string>>((acc, [key, value]) => {
            if (typeof value === 'string') {
                acc[key] = value;
            }
            return acc;
        }, {});

        return Object.keys(data).length > 0 ? data : undefined;
    } catch {
        return undefined;
    }
}

let inflightScWarmupPromise: Promise<string> | null = null;

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', engine: 'startpage', message: 'Request aborted', retryable: false });
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(signal.reason instanceof Error
                ? signal.reason
                : new AppError({ code: 'aborted', engine: 'startpage', message: 'Request aborted', retryable: false }));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (val) => {
                signal.removeEventListener('abort', onAbort);
                resolve(val);
            },
            (err) => {
                signal.removeEventListener('abort', onAbort);
                reject(err);
            }
        );
    });
}

/**
 * 获取搜索表单的 sc token。
 * 纯 HTTP + Node Worker 异步求解 Anubis PoW 挑战，完全不依赖 CDP / Playwright 浏览器兜底：
 * - 单引擎调用：最多允许求解 difficulty <= 6（约 4–6s），超限快速失败；
 * - 多引擎/级联补位：最多允许求解 difficulty <= 5（<400ms），遇 6 快速失败让位给 Bing/Brave 等快引擎；
 * - 求解失败或超限立即抛出 bot_challenge 异常，绝不唤起耗时数十秒的重型浏览器。
 */
async function getScCode(signal?: AbortSignal, isMultiEngine = false): Promise<string> {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new AppError({ code: 'aborted', engine: 'startpage', message: 'Request aborted', retryable: false });
    }
    const now = Date.now();
    if (cachedScCode && now - cachedScAt < currentSessionTtlMs) {
        return cachedScCode;
    }

    if (inflightScWarmupPromise) {
        return awaitWithSignal(inflightScWarmupPromise, signal);
    }

    inflightScWarmupPromise = (async () => {
        const warmupController = new AbortController();
        const warmupTimeoutMs = isMultiEngine ? 8000 : 20000;
        const warmupTimer = setTimeout(() => warmupController.abort(), warmupTimeoutMs);
        try {
            const session = await warmupWithAnubisPow(warmupController.signal, isMultiEngine);
            if (session) {
                cachedScCode = session.scCode;
                cachedCookies = session.cookies;
                cachedScAt = Date.now();
                currentSessionTtlMs = ANUBIS_SESSION_TTL_MS;
                console.error('✅ Startpage warmup via Anubis PoW (pure HTTP, no browser)');
                return cachedScCode;
            }
            throw new AppError({
                code: 'bot_challenge',
                retryable: false,
                engine: 'startpage',
                message: `Startpage Anubis PoW challenge failed or exceeded max difficulty (isMultiEngine: ${isMultiEngine}); fail-fast without browser fallback`
            });
        } finally {
            clearTimeout(warmupTimer);
        }
    })().finally(() => {
        inflightScWarmupPromise = null;
    });

    return awaitWithSignal(inflightScWarmupPromise, signal);
}

export function extractResultsFromHtml(html: string): SearchResult[] {
    const $ = cheerio.load(html);
    if (isCaptchaPage(html, $)) {
        cachedScCode = undefined;
        cachedCookies = undefined;
        cachedScAt = 0;
        throw new AppError({
            code: 'bot_challenge',
            retryable: false,
            engine: 'startpage',
            message: 'Startpage returned a verification or anti-bot page'
        });
    }

    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    $('a.result-title.result-link[href]').each((_, element) => {
        const link = $(element);
        const url = link.attr('href')?.trim();
        const title = link.find('h2').first().text().replace(/\s+/g, ' ').trim();
        const description = link.nextAll('p.description').first().text().replace(/\s+/g, ' ').trim();

        if (!url || !title || seenUrls.has(url)) {
            return;
        }
        seenUrls.add(url);

        let source = '';
        try {
            source = new URL(url).hostname;
        } catch {
            source = '';
        }

        results.push({
            title,
            url,
            description,
            source,
            engine: 'startpage'
        });
    });

    return results;
}

async function searchStartpagePage(
    query: string,
    page: number,
    signal?: AbortSignal,
    isMultiEngine = false
): Promise<SearchResult[]> {
    const scCode = await getScCode(signal, isMultiEngine);
    const formData = new URLSearchParams({
        query,
        cat: 'web',
        t: 'device',
        sc: scCode,
        abp: '1',
        abd: '1',
        abe: '1'
    });

    if (page > 1) {
        formData.set('page', String(page));
        formData.set('segment', 'startpage.udog');
    }

    const response = await axios.post(
        STARTPAGE_SEARCH_URL,
        formData.toString(),
        buildAxiosRequestOptions({ engine: 'startpage',
            trustedStaticHost: true,
            signal,
            headers: {
                ...COMMON_HEADERS,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': STARTPAGE_BASE_URL,
                'Referer': `${STARTPAGE_BASE_URL}/`,
                ...(cachedCookies ? { 'Cookie': cachedCookies } : {})
            },
            timeout: 20000
        })
    );

    let html = String(response.data || '');
    const interstitialPayload = extractInterstitialPayload(html);
    if (interstitialPayload) {
        const followUpResponse = await axios.post(
            STARTPAGE_SEARCH_URL,
            new URLSearchParams(interstitialPayload).toString(),
            buildAxiosRequestOptions({ engine: 'startpage',
                trustedStaticHost: true,
                signal,
                headers: {
                    ...COMMON_HEADERS,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': STARTPAGE_BASE_URL,
                    'Referer': STARTPAGE_SEARCH_URL,
                    ...(cachedCookies ? { 'Cookie': cachedCookies } : {})
                },
                timeout: 20000
            })
        );

        html = String(followUpResponse.data || '');
    }

    return extractResultsFromHtml(html);
}

import { paginateSearch } from '../../utils/pagination.js';

export async function searchStartpage(
    query: string,
    limit: number,
    options?: {
        searchMode?: AppConfig['searchMode'];
        signal?: AbortSignal;
        isMultiEngine?: boolean;
    }
): Promise<SearchResult[]> {
    const signal = options?.signal;
    const isMultiEngine = options?.isMultiEngine ?? false;
    // 未配置代理时先探测直连可达性：不可达立即报"需要代理"，避免直连挂超时拖累整次搜索
    await assertOverseasEngineUsable('startpage');

    return paginateSearch({
        limit,
        initialPage: 1,
        pageStep: 1,
        signal,
        fetchPage: (page) => searchStartpagePage(query, page, signal, isMultiEngine),
        dedupKey: (result) => result.url
    });
}
