import { SearchResult } from '../../types.js';
import { SearchExecutionContext } from '../registry.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { isAbortedError, isCascadeAbortedError } from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';

interface HnAlgoliaHit {
    title: string;
    url?: string;
    story_text?: string;
    points?: number;
    author?: string;
    num_comments?: number;
    objectID: string;
    created_at?: string;
}

interface HnAlgoliaResponse {
    hits: HnAlgoliaHit[];
    nbHits: number;
    page: number;
    nbPages: number;
}

/**
 * Hacker News (Algolia API) 搜索执行器：
 * - 调 HN 官方 Algolia 搜索引擎接口（hn.algolia.com/api/v1/search）
 * - 免 Key、无速率卡点、全球 CDN 毫秒级响应
 * - 专用于技术选型、开发者一线实测评价与开源社区热点
 */
export async function searchHackerNews(
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
        const params: Record<string, string | number> = {
            query: cleanQuery,
            tags: 'story',
            hitsPerPage: targetLimit
        };

        if (context?.timeRange) {
            const offsets = {
                day: 24 * 60 * 60,
                week: 7 * 24 * 60 * 60,
                month: 30 * 24 * 60 * 60,
                year: 365 * 24 * 60 * 60
            };
            params.numericFilters = `created_at_i>=${Math.floor(Date.now() / 1000) - offsets[context.timeRange]}`;
        }

        const url = 'https://hn.algolia.com/api/v1/search';
        const response = await requestDirectFirst('GET', url, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                engine: 'hackernews',
                signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; MyWebSearch/1.0)',
                    'Accept': 'application/json'
                },
                params,
                timeout: 8000,
                forceDirect
            })
        }), 'HackerNews Algolia API');

        const data = response.data as HnAlgoliaResponse;
        if (!data?.hits || !Array.isArray(data.hits)) {
            return [];
        }

        const results: SearchResult[] = data.hits.map((item) => {
            const hnDiscussionUrl = `https://news.ycombinator.com/item?id=${item.objectID}`;
            const targetUrl = item.url && item.url.trim() ? item.url.trim() : hnDiscussionUrl;
            const points = typeof item.points === 'number' ? `Points: ${item.points}, ` : '';
            const comments = typeof item.num_comments === 'number' ? `Comments: ${item.num_comments}` : '';
            const author = item.author ? ` by @${item.author}` : '';
            const stats = `[${points}${comments}${author}]`;
            const snippet = item.story_text ? ` ${item.story_text.replace(/\s+/g, ' ').slice(0, 200)}` : ` Discussion: ${hnDiscussionUrl}`;

            return {
                title: item.title,
                url: targetUrl,
                description: `${stats}${snippet}`,
                source: 'news.ycombinator.com',
                engine: 'hackernews'
            };
        });

        return results.slice(0, limit);
    } catch (error) {
        if (isAbortedError(error, signal)) {
            if (isCascadeAbortedError(error, signal)) {
                metrics.debug('[hackernews] Search cancelled: target satisfied by sibling engine');
            }
            throw error;
        }

        console.error('[hackernews] search failed:', error instanceof Error ? error.message : String(error));
        throw error;
    }
}
