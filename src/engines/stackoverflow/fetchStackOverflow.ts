import * as cheerio from 'cheerio';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { htmlToMarkdown } from '../../utils/markdown.js';

interface StackExchangeQuestionItem {
    question_id: number;
    title: string;
    score: number;
    body: string;
    tags?: string[];
    is_answered?: boolean;
    accepted_answer_id?: number;
    link?: string;
}

interface StackExchangeAnswerItem {
    answer_id: number;
    score: number;
    is_accepted: boolean;
    body: string;
}

interface StackExchangeApiResponse<T> {
    items: T[];
    error_id?: number;
    error_message?: string;
    error_name?: string;
}

/**
 * 判定传入 URL 是否为 Stack Overflow 问答页（如 https://stackoverflow.com/questions/11227809/...）
 */
export function isStackOverflowQuestionUrl(rawUrl: string): boolean {
    try {
        const u = new URL(rawUrl);
        return (u.hostname === 'stackoverflow.com' || u.hostname.endsWith('.stackoverflow.com')) &&
            /^\/questions\/\d+/.test(u.pathname);
    } catch {
        return false;
    }
}

/**
 * 提取 Stack Overflow 问题 ID
 */
export function extractStackOverflowQuestionId(url: string): string | null {
    const match = url.match(/\/questions\/(\d+)/);
    return match?.[1] ?? null;
}

/**
 * 通过 StackExchange 官方 API 抓取 Stack Overflow 问答正文及高赞/采纳回答：
 * - 0.7s 极速响应，原生无 Cloudflare 403 / 反爬拦截
 * - 包含问题正文、标签、得分、采纳答案与前 2~3 个高赞答案
 * - 自动转换为清晰干净的 Markdown
 * - 若 API 超限或不可用，返回 null 由调用方平滑回退至通用网页抓取
 */
export async function fetchStackOverflowQuestion(
    url: string,
    options?: { signal?: AbortSignal }
): Promise<{ title: string; content: string } | null> {
    const questionId = extractStackOverflowQuestionId(url);
    if (!questionId) {
        return null;
    }

    const apiKey = (process.env.STACKOVERFLOW_API_KEY || process.env.STACKEXCHANGE_API_KEY)?.trim();
    const headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; MyWebSearch/1.0)',
        'Accept': 'application/json'
    };

    try {
        const questionApiUrl = `https://api.stackexchange.com/2.3/questions/${questionId}`;
        const questionParams: Record<string, string | number> = {
            site: 'stackoverflow',
            filter: 'withbody',
            ...(apiKey ? { key: apiKey } : {})
        };

        const qRes = await requestDirectFirst('GET', questionApiUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                engine: 'stackoverflow',
                signal: options?.signal,
                headers,
                params: questionParams,
                timeout: 8000,
                forceDirect
            })
        }), 'StackExchange Question API');

        const qData = qRes.data as StackExchangeApiResponse<StackExchangeQuestionItem>;
        if (!qData || !qData.items || qData.items.length === 0) {
            return null;
        }

        const q = qData.items[0];
        if (!q) {
            return null;
        }
        const cleanTitle = cheerio.load(q.title || '').text() || `Stack Overflow Question #${questionId}`;

        // 并行或顺序获取前 3 个最高赞回答
        let answersHtml = '';
        try {
            const answersApiUrl = `https://api.stackexchange.com/2.3/questions/${questionId}/answers`;
            const answersParams: Record<string, string | number> = {
                site: 'stackoverflow',
                order: 'desc',
                sort: 'votes',
                filter: 'withbody',
                pagesize: 3,
                ...(apiKey ? { key: apiKey } : {})
            };

            const aRes = await requestDirectFirst('GET', answersApiUrl, (forceDirect) => ({
                ...buildAxiosRequestOptions({
                    engine: 'stackoverflow',
                    signal: options?.signal,
                    headers,
                    params: answersParams,
                    timeout: 8000,
                    forceDirect
                })
            }), 'StackExchange Answers API');

            const aData = aRes.data as StackExchangeApiResponse<StackExchangeAnswerItem>;
            if (aData && Array.isArray(aData.items) && aData.items.length > 0) {
                const answerParts: string[] = [];
                for (const a of aData.items) {
                    const label = a.is_accepted ? 'Accepted Answer' : 'High-Voted Answer';
                    answerParts.push(`<h2>${label} (Score: ${a.score})</h2>\n<div>${a.body || ''}</div>`);
                }
                answersHtml = answerParts.join('\n\n');
            }
        } catch {
            // 回答拉取失败不阻断问题正文返回
        }

        const tagList = Array.isArray(q.tags) && q.tags.length > 0 ? q.tags.join(', ') : '';
        const metaInfo = `<p><strong>Score:</strong> ${q.score}${tagList ? ` | <strong>Tags:</strong> ${tagList}` : ''}</p>`;
        const rawHtml = [
            `<h1>${cleanTitle}</h1>`,
            metaInfo,
            `<h2>Question</h2>\n<div>${q.body || ''}</div>`,
            answersHtml
        ].filter(Boolean).join('\n\n');

        const markdown = htmlToMarkdown(rawHtml);
        return {
            title: cleanTitle,
            content: markdown
        };
    } catch {
        return null;
    }
}
