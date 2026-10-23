import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import type { SearchExecutionContext } from '../../core/search/searchTypes.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { AppError, isAbortedError, isCascadeAbortedError } from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';

interface StackExchangeItem {
    title: string;
    link: string;
    score: number;
    is_answered: boolean;
    answer_count: number;
    tags?: string[];
    creation_date?: number;
}

interface StackExchangeResponse {
    items: StackExchangeItem[];
    has_more?: boolean;
    quota_max?: number;
    quota_remaining?: number;
    error_id?: number;
    error_message?: string;
    error_name?: string;
}

const COMPARISON_TOKENS = /\b(vs\.?|versus|difference|differences|between|compare[ds]?|compared)\b/gi;
const SO_STOPWORDS = new Set([
    'how', 'to', 'the', 'a', 'an', 'in', 'of', 'for', 'with', 'and', 'or', 'on', 'is', 'are',
    'what', 'why', 'best', 'practices', 'practice', 'guide', 'tutorial', 'using', 'use', 'work', 'works'
]);

/**
 * StackExchange 的 `q` 是**全词 AND**语义：`asyncio gather vs create_task difference`
 * 会返回 0 条（实测），而 `asyncio gather create_task` 返回 6 条。
 * 因此按「原查询 → 去比较词 → 去停用词 → 标识符组合」逐级放松，且把降级告知调用方。
 */
export function relaxStackOverflowQueries(query: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (value: string): void => {
        const normalized = value.replace(/\s+/g, ' ').trim();
        const key = normalized.toLowerCase();
        if (normalized && !seen.has(key)) {
            seen.add(key);
            out.push(normalized);
        }
    };

    add(query);
    add(query.replace(COMPARISON_TOKENS, ' '));

    const identifiers = query
        .split(/\s+/)
        .filter((token) => /^[A-Za-z_][\w.+-]*$/.test(token) && !SO_STOPWORDS.has(token.toLowerCase()));
    if (identifiers.length >= 2) {
        add(identifiers.join(' '));
    }
    if (identifiers.length >= 1) {
        add(identifiers.slice(0, 3).join(' '));
    }
    return out;
}

async function fetchStackOverflowData(
    cleanQuery: string,
    targetLimit: number,
    apiKey?: string,
    signal?: AbortSignal,
    timeRange?: 'day' | 'week' | 'month' | 'year'
): Promise<StackExchangeResponse> {
    const url = 'https://api.stackexchange.com/2.3/search/advanced';
    const params: Record<string, string | number> = {
        order: 'desc',
        sort: 'relevance',
        q: cleanQuery,
        site: 'stackoverflow',
        pagesize: targetLimit,
        ...(apiKey ? { key: apiKey } : {})
    };

    if (timeRange) {
        const offsets = {
            day: 24 * 60 * 60,
            week: 7 * 24 * 60 * 60,
            month: 30 * 24 * 60 * 60,
            year: 365 * 24 * 60 * 60
        };
        params.fromdate = Math.floor(Date.now() / 1000) - offsets[timeRange];
    }

    const response = await requestDirectFirst('GET', url, (forceDirect) => ({
        ...buildAxiosRequestOptions({
            engine: 'stackoverflow',
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; MyWebSearch/1.0)',
                'Accept': 'application/json'
            },
            params,
            timeout: 10000,
            forceDirect
        })
    }), 'StackExchange API');

    return response.data as StackExchangeResponse;
}

/**
 * Stack Overflow 官方搜索执行器：
 * - 调 Stack Exchange 官方 API（api.stackexchange.com/2.3/search/advanced）
 * - 默认免 Key（每日 300 次匿名配额）；配置 STACKOVERFLOW_API_KEY 时提速至每日 10,000 次配额
 * - 若配置的 Key 无效或超限，自动平滑降级至匿名配额重试
 * - 直达原站问答，过滤机翻垃圾采集站，带点赞数与 Accepted 标记
 */
export async function searchStackOverflow(
    query: string,
    limit: number,
    context?: SearchExecutionContext
): Promise<SearchResult[]> {
    const signal = context?.signal;
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Request aborted');
    }

    const cleanQuery = query.trim();
    if (!cleanQuery) {
        return [];
    }

    const targetLimit = Math.max(1, Math.min(limit, 30));
    const apiKey = (process.env.STACKOVERFLOW_API_KEY || process.env.STACKEXCHANGE_API_KEY)?.trim();

    try {
        const candidates = relaxStackOverflowQueries(cleanQuery);
        let data = await fetchStackOverflowData(candidates[0]!, targetLimit, apiKey, signal, context?.timeRange);
        let usedQuery = candidates[0]!;
        let candidateIndex = 0;

        // 查询放松：全词 AND 语义下比较词/停用词会把结果卡成 0 条
        while ((!data.items || data.items.length === 0) && !data.error_id && candidateIndex + 1 < candidates.length) {
            candidateIndex += 1;
            usedQuery = candidates[candidateIndex]!;
            data = await fetchStackOverflowData(usedQuery, targetLimit, apiKey, signal, context?.timeRange);
        }
        if (candidateIndex > 0) {
            context?.requestContext?.addWarning?.(
                `stackoverflow: relaxed query to "${usedQuery}" (full query matched no questions)`
            );
        }

        // 如果配置了 Key 但 API 报错（例如 Key 输错 400 bad_parameter / 401 / 403），自动回退为匿名请求
        if (apiKey && data.error_id && (data.error_id === 400 || data.error_id === 401 || data.error_id === 403 || /key/i.test(data.error_message || ''))) {
            console.warn(`⚠️ [StackOverflow] STACKOVERFLOW_API_KEY invalid (${data.error_message || `error_id ${data.error_id}`}), falling back to anonymous quota...`);
            data = await fetchStackOverflowData(cleanQuery, targetLimit, undefined, signal, context?.timeRange);
        }

        if (data.error_id) {
            if (data.error_id === 502 || /throttle/i.test(data.error_message || '')) {
                throw new AppError({
                    code: 'rate_limited',
                    engine: 'stackoverflow',
                    retryable: false,
                    message: `StackExchange API rate limit exceeded: ${data.error_message || 'throttle violation'}`
                });
            }
            throw new AppError({
                code: 'engine_error',
                engine: 'stackoverflow',
                retryable: true,
                message: `StackExchange API error: ${data.error_message || `error_id ${data.error_id}`}`
            });
        }

        if (!data.items || !Array.isArray(data.items)) {
            return [];
        }

        const results: SearchResult[] = data.items.map((item) => {
            // 解码 HTML 实体（如 &quot; &#39; &amp;）
            const decodedTitle = cheerio.load(item.title).text().trim();
            const tags = Array.isArray(item.tags) && item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
            const accepted = item.is_answered ? ', Accepted' : '';
            const description = `[Score: ${item.score}, Answers: ${item.answer_count}${accepted}]${tags}`;
            // 质量信号：0 回答/负分对「学最佳实践」这类意图几乎没有价值，交给重排阶段降权
            const rankBoost = item.answer_count === 0
                ? (item.score <= 0 ? -35 : -20)
                : (item.score < 0 ? -25 : 0);

            return {
                title: decodedTitle,
                url: item.link,
                description,
                source: 'stackoverflow.com',
                engine: 'stackoverflow',
                ...(rankBoost !== 0 ? { rankBoost } : {})
            };
        });

        return results.slice(0, limit);
    } catch (error) {
        if (isAbortedError(error, signal)) {
            if (isCascadeAbortedError(error, signal)) {
                metrics.debug('[stackoverflow] Search cancelled: target satisfied by sibling engine');
            }
            throw error;
        }

        console.error('[stackoverflow] search failed:', error instanceof Error ? error.message : String(error));
        throw error;
    }
}
