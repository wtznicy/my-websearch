import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import type { SearchExecutionContext } from '../../core/search/searchTypes.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { isAbortedError, isCascadeAbortedError } from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';

/**
 * arXiv 学术论文检索执行器：
 * - 调 arXiv 官方公开 API（export.arxiv.org/api/query）
 * - 免 Key、零风控、数据结构极其稳定
 * - 自动提取论文标题、作者列表、发表年份、完整摘要与官方 PDF/HTML 链接
 */
export async function searchArxiv(
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
        let searchQuery = `all:${cleanQuery}`;
        if (context?.timeRange) {
            const offsets = {
                day: 24 * 60 * 60 * 1000,
                week: 7 * 24 * 60 * 60 * 1000,
                month: 30 * 24 * 60 * 60 * 1000,
                year: 365 * 24 * 60 * 60 * 1000
            };
            const fromDate = new Date(Date.now() - offsets[context.timeRange]).toISOString().slice(0, 10).replace(/-/g, '');
            const toDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            searchQuery = `${searchQuery} AND submittedDate:[${fromDate}0000 TO ${toDate}2359]`;
        }

        const url = 'http://export.arxiv.org/api/query';
        const response = await requestDirectFirst('GET', url, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                engine: 'arxiv',
                signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; MyWebSearch/1.0)',
                    'Accept': 'application/atom+xml, application/xml, text/xml'
                },
                params: {
                    search_query: searchQuery,
                    start: 0,
                    max_results: targetLimit
                },
                timeout: 10000,
                responseType: 'text',
                forceDirect
            })
        }), 'arXiv API');

        const xml = String(response.data || '');
        if (!xml.trim()) {
            return [];
        }

        const $ = cheerio.load(xml, { xmlMode: true });
        const results: SearchResult[] = [];

        $('entry').each((_, entryEl) => {
            const $entry = $(entryEl);
            const title = $entry.find('title').text().replace(/\s+/g, ' ').trim();
            const summary = $entry.find('summary').text().replace(/\s+/g, ' ').trim();
            const rawId = $entry.find('id').text().trim();
            const id = rawId.replace(/^http:/, 'https:');
            const published = $entry.find('published').text().trim().slice(0, 10);

            const authors = $entry.find('author name')
                .map((__, nameEl) => $(nameEl).text().trim())
                .get()
                .slice(0, 3)
                .join(', ');

            if (title && id) {
                const authorsText = authors ? `, by ${authors}` : '';
                const dateText = published ? `[arXiv ${published}${authorsText}] ` : '[arXiv] ';
                const description = `${dateText}${summary.slice(0, 250)}`;

                results.push({
                    title,
                    url: id,
                    description,
                    source: 'arxiv.org',
                    engine: 'arxiv'
                });
            }
        });

        return results.slice(0, limit);
    } catch (error) {
        if (isAbortedError(error, signal)) {
            if (isCascadeAbortedError(error, signal)) {
                metrics.debug('[arxiv] Search cancelled: target satisfied by sibling engine');
            }
            throw error;
        }

        console.error('[arxiv] search failed:', error instanceof Error ? error.message : String(error));
        throw error;
    }
}
