import axios from 'axios';
import { SearchResult } from '../../types.js';
import { SearchExecutionContext } from '../registry.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { AppError, isAbortedError, isCascadeAbortedError } from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';

interface GitHubIssueItem {
    title: string;
    html_url: string;
    state?: string;
    body?: string;
    user?: { login: string };
    created_at?: string;
}

interface GitHubSearchIssuesResponse {
    total_count: number;
    items: GitHubIssueItem[];
}

interface GitHubRepoItem {
    full_name: string;
    html_url: string;
    description?: string;
    stargazers_count?: number;
    language?: string;
}

interface GitHubSearchReposResponse {
    total_count: number;
    items: GitHubRepoItem[];
}

/**
 * GitHub 官方 API 搜索执行器：
 * - 优先检索 Issues 与 Discussions（最适合开发者排查报错、寻找解决方案）
 * - 若 Issue 结果少于 2 条或查询为纯仓库名，补充检索 GitHub Repositories
 * - 免 Key 10次/分，配置 GITHUB_TOKEN 时 30次/分，0 反爬风控
 */
export async function searchGithub(
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

    const headers: Record<string, string> = {
        'User-Agent': 'GitHub-Search-Agent/1.0',
        'Accept': 'application/vnd.github.v3+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    };

    const results: SearchResult[] = [];
    const targetLimit = Math.max(1, Math.min(limit, 30));

    try {
        // 1. 搜索 GitHub Issues
        const issuesUrl = 'https://api.github.com/search/issues';
        const issuesRes = await requestDirectFirst('GET', issuesUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                engine: 'github',
                signal,
                headers,
                params: {
                    q: cleanQuery,
                    per_page: targetLimit
                },
                timeout: 10000,
                forceDirect
            })
        }), 'GitHub Issues API');

        const issuesData = issuesRes.data as GitHubSearchIssuesResponse;
        if (issuesData?.items && Array.isArray(issuesData.items)) {
            for (const item of issuesData.items) {
                const state = item.state ? `[${item.state.toUpperCase()}] ` : '';
                const bodySnippet = (item.body || '').replace(/\s+/g, ' ').slice(0, 250).trim();
                const author = item.user?.login ? ` (by @${item.user.login})` : '';

                results.push({
                    title: item.title,
                    url: item.html_url,
                    description: `${state}${bodySnippet}${author}`,
                    source: 'github.com',
                    engine: 'github'
                });
            }
        }

        // 2. 若 Issues 结果不足或未满 limit，补充搜索 Repositories
        if (results.length < targetLimit) {
            const needed = targetLimit - results.length;
            const reposUrl = 'https://api.github.com/search/repositories';
            const reposRes = await requestDirectFirst('GET', reposUrl, (forceDirect) => ({
                ...buildAxiosRequestOptions({
                    engine: 'github',
                    signal,
                    headers,
                    params: {
                        q: cleanQuery,
                        per_page: needed
                    },
                    timeout: 10000,
                    forceDirect
                })
            }), 'GitHub Repositories API');

            const reposData = reposRes.data as GitHubSearchReposResponse;
            if (reposData?.items && Array.isArray(reposData.items)) {
                for (const item of reposData.items) {
                    const stars = typeof item.stargazers_count === 'number' ? `★${item.stargazers_count} ` : '';
                    const lang = item.language ? `[${item.language}] ` : '';
                    const desc = (item.description || '').slice(0, 250).trim();

                    results.push({
                        title: item.full_name,
                        url: item.html_url,
                        description: `${stars}${lang}${desc}`,
                        source: 'github.com',
                        engine: 'github'
                    });
                }
            }
        }

        return results.slice(0, limit);
    } catch (error) {
        if (isAbortedError(error, signal)) {
            if (isCascadeAbortedError(error, signal)) {
                metrics.debug('[github] Search cancelled: target satisfied by sibling engine');
            }
            throw error;
        }

        if (axios.isAxiosError(error) && error.response?.status === 403) {
            throw new AppError({
                code: 'rate_limited',
                engine: 'github',
                retryable: false,
                message: 'GitHub API rate limit exceeded. Set GITHUB_TOKEN to increase limit.'
            });
        }

        console.error('[github] search failed:', error instanceof Error ? error.message : String(error));
        throw error;
    }
}
