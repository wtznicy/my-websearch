import axios from 'axios';
import { SearchResult } from '../../types.js';
import type { SearchExecutionContext } from '../../core/search/searchTypes.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { AppError, isAbortedError, isCascadeAbortedError } from '../../core/errors.js';
import { metrics } from '../../core/metrics.js';

export interface GitHubIssueItem {
    number?: number;
    title: string;
    html_url: string;
    state?: string;
    body?: string;
    user?: { login: string };
    comments?: number;
    reactions?: { total_count?: number; '+1'?: number };
    created_at?: string;
    updated_at?: string;
}

export interface GitHubSearchIssuesResponse {
    total_count: number;
    items: GitHubIssueItem[];
}

export interface GitHubRepoItem {
    full_name: string;
    html_url: string;
    description?: string;
    stargazers_count?: number;
    language?: string;
    updated_at?: string;
}

export interface GitHubSearchReposResponse {
    total_count: number;
    items: GitHubRepoItem[];
}

export interface GitHubRepoSpec {
    owner: string;
    repo: string;
}

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * 识别精确仓库查询：
 * - facebook/react
 * - https://github.com/facebook/react
 * - github.com/facebook/react/tree/main
 * 只接受单个 owner/repo，不把普通搜索词误判为仓库。
 */
export function parseGitHubRepoSpec(query: string): GitHubRepoSpec | null {
    const raw = query.trim();
    if (!raw) {
        return null;
    }

    let owner: string | undefined;
    let repo: string | undefined;
    const urlMatch = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)/i);
    if (urlMatch) {
        owner = urlMatch[1];
        repo = urlMatch[2];
    } else {
        const pairMatch = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
        if (!pairMatch) {
            return null;
        }
        owner = pairMatch[1];
        repo = pairMatch[2];
    }

    repo = repo?.replace(/\.git$/i, '');
    if (!owner || !repo || !GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) {
        return null;
    }
    return { owner, repo };
}

/**
 * 格式化 Star 数量，如 1234 -> 1.2k
 */
export function formatStars(count: number): string {
    if (count >= 1000000) {
        return (count / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    }
    if (count >= 1000) {
        return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return String(count);
}

/**
 * 自动识别查询是否偏向问题、报错或缺陷排查意图
 */
export function isGithubIssueIntent(query: string): boolean {
    const q = query.toLowerCase();
    // 包含 GitHub search 限定符
    if (/\b(repo|is|type|author|label|milestone|project):/i.test(q)) {
        return true;
    }
    // 报错、排错特征词
    const issueKeywords = [
        'error', 'bug', 'fail', 'failed', 'failing', 'failure',
        'issue', 'issues', 'cannot', 'cant', "can't", 'couldnt', "couldn't",
        'crash', 'crashed', 'crashing', 'exception', 'panic',
        'warn', 'warning', 'broken', 'problem', 'fix', 'leak',
        'freeze', 'hang', 'segfault', 'undefined', 'nullpointer',
        'mismatch', 'not working', 'trouble', 'resolve',
        '报错', '崩溃', '异常', '失败', '无法', '卡死', '缺陷', '问题'
    ];
    for (const kw of issueKeywords) {
        if (q.includes(kw)) {
            return true;
        }
    }
    return false;
}

export function formatIssueItem(item: GitHubIssueItem & { full_name?: string }): SearchResult {
    const state = item.state ? `[${item.state.toUpperCase()}${item.number ? ` #${item.number}` : ''}] ` : '';
    const author = item.user?.login ? `by @${item.user.login}` : '';
    const comments = typeof item.comments === 'number' && item.comments > 0 ? `💬${item.comments}` : '';
    const reactions = item.reactions && typeof item.reactions.total_count === 'number' && item.reactions.total_count > 0
        ? `👍${item.reactions.total_count}`
        : '';

    const metaParts = [author, comments, reactions].filter(Boolean);
    const metaStr = metaParts.length > 0 ? ` (${metaParts.join(' ')})` : '';
    const bodySnippet = (item.body || '').replace(/\s+/g, ' ').slice(0, 240).trim();

    return {
        title: item.title || item.full_name || '',
        url: item.html_url,
        description: `${state}${bodySnippet ? `${bodySnippet} ` : ''}${metaStr}`.trim(),
        source: 'github.com',
        engine: 'github'
    };
}

export function formatRepoItem(item: GitHubRepoItem & { title?: string; body?: string }): SearchResult {
    const stars = typeof item.stargazers_count === 'number' ? `★${item.stargazers_count} ` : '';
    const lang = item.language ? `[${item.language}] ` : '';
    const updated = item.updated_at ? ` (Updated: ${item.updated_at.slice(0, 10)})` : '';
    const desc = (item.description || item.body || '').slice(0, 240).trim();

    return {
        title: item.full_name || item.title || '',
        url: item.html_url,
        description: `${stars}${lang}${desc}${updated}`.trim(),
        source: 'github.com',
        engine: 'github'
    };
}

async function searchIssues(
    cleanQuery: string,
    limit: number,
    headers: Record<string, string>,
    signal?: AbortSignal
): Promise<SearchResult[]> {
    const issuesUrl = 'https://api.github.com/search/issues';
    const issuesRes = await requestDirectFirst('GET', issuesUrl, (forceDirect) => ({
        ...buildAxiosRequestOptions({
            engine: 'github',
            signal,
            headers,
            params: {
                q: cleanQuery,
                per_page: Math.max(1, Math.min(limit, 30))
            },
            timeout: 10000,
            forceDirect
        })
    }), 'GitHub Issues API');

    const issuesData = issuesRes.data as GitHubSearchIssuesResponse;
    const results: SearchResult[] = [];
    if (issuesData?.items && Array.isArray(issuesData.items)) {
        for (const item of issuesData.items) {
            results.push(formatIssueItem(item));
        }
    }
    return results;
}

async function searchRepos(
    cleanQuery: string,
    limit: number,
    headers: Record<string, string>,
    signal?: AbortSignal
): Promise<SearchResult[]> {
    const reposUrl = 'https://api.github.com/search/repositories';
    const reposRes = await requestDirectFirst('GET', reposUrl, (forceDirect) => ({
        ...buildAxiosRequestOptions({
            engine: 'github',
            signal,
            headers,
            params: {
                q: cleanQuery,
                sort: 'stars',
                per_page: Math.max(1, Math.min(limit, 30))
            },
            timeout: 10000,
            forceDirect
        })
    }), 'GitHub Repositories API');

    const reposData = reposRes.data as GitHubSearchReposResponse;
    const results: SearchResult[] = [];
    if (reposData?.items && Array.isArray(reposData.items)) {
        for (const item of reposData.items) {
            results.push(formatRepoItem(item));
        }
    }
    return results;
}

function buildGithubHeaders(token?: string): Record<string, string> {
    return {
        'User-Agent': 'GitHub-Search-Agent/1.0',
        'Accept': 'application/vnd.github.v3+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
}

async function fetchExactRepo(
    spec: GitHubRepoSpec,
    headers: Record<string, string>,
    signal?: AbortSignal
): Promise<SearchResult> {
    const repoUrl = `https://api.github.com/repos/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repo)}`;
    const res = await requestDirectFirst('GET', repoUrl, (forceDirect) => ({
        ...buildAxiosRequestOptions({
            engine: 'github',
            signal,
            headers,
            timeout: 8000,
            forceDirect
        })
    }), 'GitHub repository API');
    return { ...formatRepoItem(res.data as GitHubRepoItem), rankBoost: 100 };
}

async function fetchGithubData(
    cleanQuery: string,
    targetLimit: number,
    token?: string,
    signal?: AbortSignal
): Promise<SearchResult[]> {
    const headers = buildGithubHeaders(token);
    const isIssueFirst = isGithubIssueIntent(cleanQuery);
    const results: SearchResult[] = [];

    if (isIssueFirst) {
        // 1. 意图偏向排错，优先检索 Issues
        const issues = await searchIssues(cleanQuery, targetLimit, headers, signal);
        results.push(...issues);

        // 2. 若 Issue 结果不足 targetLimit，补充搜索 Repositories
        if (results.length < targetLimit) {
            const needed = targetLimit - results.length;
            try {
                const repos = await searchRepos(cleanQuery, needed, headers, signal);
                results.push(...repos);
            } catch (err) {
                // 补充搜索失败不阻断已有 Issue 结果
                metrics.debug(`[github] fallback repo search skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    } else {
        // 1. 普通库名/技术词，优先检索 Repositories (按 star 排序)
        const repos = await searchRepos(cleanQuery, targetLimit, headers, signal);
        results.push(...repos);

        // 2. 若 Repos 结果不足，补充搜索 Issues
        if (results.length < targetLimit) {
            const needed = targetLimit - results.length;
            try {
                const issues = await searchIssues(cleanQuery, needed, headers, signal);
                results.push(...issues);
            } catch (err) {
                // 补充搜索失败不阻断已有 Repo 结果
                metrics.debug(`[github] fallback issue search skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    return results;
}

/**
 * GitHub 官方 API 搜索执行器：
 * - 智能意图识别：报错/bug/限定词优先检索 Issues，开源库名优先检索 Repositories (带 stars 排序)
 * - 若主意图结果未满 limit，自动由副类型补齐
 * - 免 Key 10次/分，配置 GITHUB_TOKEN 时 30次/分，0 反爬风控
 * - 若 GITHUB_TOKEN 无效（401）或额度超限（403），自动回退至匿名搜索
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
    if (!cleanQuery || limit <= 0) {
        return [];
    }

    let effectiveQuery = cleanQuery;
    if (context?.timeRange && !/created:[><=]/i.test(cleanQuery)) {
        const offsets = {
            day: 24 * 60 * 60 * 1000,
            week: 7 * 24 * 60 * 60 * 1000,
            month: 30 * 24 * 60 * 60 * 1000,
            year: 365 * 24 * 60 * 60 * 1000
        };
        const sinceDate = new Date(Date.now() - offsets[context.timeRange]).toISOString().slice(0, 10);
        effectiveQuery = `${cleanQuery} created:>=${sinceDate}`;
    }

    const targetLimit = Math.max(1, Math.min(limit, 30));
    const userToken = process.env.GITHUB_TOKEN?.trim();

    // P0：精确 owner/repo（或 GitHub URL）直接查 /repos，避免被 Search API 的相关性排序带偏。
    // timeRange 需要过滤，仍走普通搜索路径。
    const exactSpec = !context?.timeRange ? parseGitHubRepoSpec(cleanQuery) : null;
    if (exactSpec) {
        let exactResult: SearchResult | undefined;
        try {
            exactResult = await fetchExactRepo(exactSpec, buildGithubHeaders(userToken), signal);
        } catch (error) {
            if (isAbortedError(error, signal)) {
                throw error;
            }
            // Token 失效/额度耗尽时，用匿名配额重试一次精确仓库查询
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (userToken && (status === 401 || status === 403)) {
                try {
                    exactResult = await fetchExactRepo(exactSpec, buildGithubHeaders(), signal);
                } catch (fallbackError) {
                    if (isAbortedError(fallbackError, signal)) {
                        throw fallbackError;
                    }
                    metrics.debug(`[github] exact repo anonymous retry skipped: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
                }
            } else {
                metrics.debug(`[github] exact repo lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        if (exactResult) {
            // limit=1 时无需再打 Search API，直接确定性返回，省一次配额。
            if (targetLimit <= 1) {
                return [exactResult];
            }
            try {
                const related = await fetchGithubData(effectiveQuery, targetLimit, userToken, signal);
                const exactKey = exactResult.url.replace(/\/$/, '').toLowerCase();
                return [exactResult, ...related.filter((item) => item.url.replace(/\/$/, '').toLowerCase() !== exactKey)].slice(0, limit);
            } catch (error) {
                if (isAbortedError(error, signal)) {
                    throw error;
                }
                metrics.debug(`[github] exact repo related search skipped: ${error instanceof Error ? error.message : String(error)}`);
                return [exactResult].slice(0, limit);
            }
        }
    }

    try {
        const results = await fetchGithubData(effectiveQuery, targetLimit, userToken, signal);
        return results.slice(0, limit);
    } catch (error) {
        if (isAbortedError(error, signal)) {
            if (isCascadeAbortedError(error, signal)) {
                metrics.debug('[github] Search cancelled: target satisfied by sibling engine');
            }
            throw error;
        }

        // 若带 Token 请求遭遇 401（Token 无效/过期/输错）或 403（Token 自身配额耗尽），降级为匿名请求兜底！
        if (userToken && axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
            const status = error.response.status;
            console.warn(`⚠️ [GitHub] GITHUB_TOKEN failed (HTTP ${status}), falling back to anonymous search...`);
            try {
                const fallbackResults = await fetchGithubData(cleanQuery, targetLimit, undefined, signal);
                return fallbackResults.slice(0, limit);
            } catch (fallbackError) {
                if (isAbortedError(fallbackError, signal)) {
                    throw fallbackError;
                }
                if (axios.isAxiosError(fallbackError) && fallbackError.response?.status === 403) {
                    throw new AppError({
                        code: 'rate_limited',
                        engine: 'github',
                        retryable: false,
                        message: 'GitHub API rate limit exceeded (both token and anonymous quotas exhausted).'
                    });
                }
                throw fallbackError;
            }
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
