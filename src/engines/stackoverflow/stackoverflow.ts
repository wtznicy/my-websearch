import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { SearchExecutionContext } from '../registry.js';
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
}

/**
 * Stack Overflow 官方搜索执行器：
 * - 调 Stack Exchange 官方 API（api.stackexchange.com/2.3/search/advanced）
 * - 免 Key、每日 300 次匿名配额、0 反爬风控
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

    try {
        const url = 'https://api.stackexchange.com/2.3/search/advanced';
        const response = await requestDirectFirst('GET', url, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                engine: 'stackoverflow',
                signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; MyWebSearch/1.0)',
                    'Accept': 'application/json'
                },
                params: {
                    order: 'desc',
                    sort: 'relevance',
                    q: cleanQuery,
                    site: 'stackoverflow',
                    pagesize: targetLimit
                },
                timeout: 10000,
                forceDirect
            })
        }), 'StackExchange API');

        const data = response.data as StackExchangeResponse;
        if (data.error_id) {
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

            return {
                title: decodedTitle,
                url: item.link,
                description,
                source: 'stackoverflow.com',
                engine: 'stackoverflow'
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
