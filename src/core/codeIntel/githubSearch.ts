import { AppError } from '../errors.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';
import { getOptionalString } from '../../config/env.js';
import { rankCodePaths } from './codeSymbolParser.js';

export function parseGitHubRepoSpec(raw: string): { owner: string; repo: string } | null {
    const trimmed = raw.trim().replace(/\.git$/i, '');
    if (!trimmed) return null;

    const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s?#]+)/i)
        || trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i);
    if (urlMatch?.[1] && urlMatch[2]) {
        return { owner: urlMatch[1], repo: urlMatch[2] };
    }

    const shortMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    return shortMatch?.[1] && shortMatch[2] ? { owner: shortMatch[1], repo: shortMatch[2] } : null;
}

export function buildRawFileUrls(owner: string, repo: string, ref: string, filePath: string): string[] {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    return [
        `https://raw.githubusercontent.com/${encodedOwner}/${encodedRepo}/${encodeURIComponent(ref)}/${encodedPath}`,
        `https://cdn.jsdelivr.net/gh/${encodedOwner}/${encodedRepo}@${encodeURIComponent(ref)}/${encodedPath}`
    ];
}

interface GitHubCodeSearchItem {
    path?: string;
    text_matches?: Array<{ fragment?: string }>;
}

interface GitHubCodeSearchResponse {
    items?: GitHubCodeSearchItem[];
}

export function githubHeaders(): Record<string, string> {
    const token = getOptionalString('GITHUB_TOKEN');
    return {
        'User-Agent': DEFAULT_DESKTOP_UA,
        'Accept': 'application/vnd.github.text-match+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
}

export async function searchGitHubCode(
    owner: string,
    repo: string,
    symbol: string,
    maxResults: number,
    signal?: AbortSignal
): Promise<string[]> {
    const token = getOptionalString('GITHUB_TOKEN');
    if (!token) {
        throw new AppError({
            code: 'missing_api_key',
            retryable: false,
            engine: 'github',
            message: 'codeSymbol requires GITHUB_TOKEN for GitHub code search.',
            hint: '配置 GITHUB_TOKEN 后重试；未配置时可用 fetchGithubContent 直接读取已知路径。'
        });
    }

    const query = `${symbol} repo:${owner}/${repo}`;
    const perPage = Math.min(Math.max(maxResults * 10, 50), 100);
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${perPage}`;
    const response = await requestDirectFirst(
        'GET',
        url,
        (forceDirect) => buildAxiosRequestOptions({
            headers: githubHeaders(),
            timeout: 10000,
            responseType: 'json',
            signal,
            forceDirect
        }),
        'GitHub code search'
    );

    if (response.status === 401 || response.status === 403) {
        throw new AppError({
            code: 'engine_error',
            retryable: false,
            engine: 'github',
            message: `GitHub code search returned HTTP ${response.status}.`,
            hint: '检查 GITHUB_TOKEN 是否有效，以及是否有 code search 权限。'
        });
    }
    if (response.status !== 200) {
        throw new AppError({
            code: 'engine_error',
            retryable: response.status >= 500,
            engine: 'github',
            message: `GitHub code search returned HTTP ${response.status}.`
        });
    }

    const data = response.data as GitHubCodeSearchResponse;
    return rankCodePaths((data.items ?? [])
        .map((item) => item.path)
        .filter((path): path is string => Boolean(path)),
        symbol
    );
}

export async function fetchRawFile(
    owner: string,
    repo: string,
    ref: string,
    path: string,
    signal?: AbortSignal
): Promise<string | null> {
    for (const url of buildRawFileUrls(owner, repo, ref, path)) {
        if (signal?.aborted) return null;
        try {
            const response = await requestDirectFirst(
                'GET',
                url,
                (forceDirect) => buildAxiosRequestOptions({
                    headers: { 'User-Agent': DEFAULT_DESKTOP_UA },
                    timeout: 8000,
                    responseType: 'text',
                    signal,
                    forceDirect
                }),
                url.includes('cdn.jsdelivr.net') ? 'jsDelivr raw file' : 'GitHub raw file'
            );
            if (response.status === 200 && typeof response.data === 'string') {
                return response.data;
            }
        } catch {
            // Try the next CDN.
        }
    }

    // Private repositories are not served by raw.githubusercontent.com/jsDelivr;
    // use the authenticated Contents API as the last resort.
    const token = getOptionalString('GITHUB_TOKEN');
    if (!token) return null;
    try {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
        const response = await requestDirectFirst(
            'GET',
            apiUrl,
            (forceDirect) => buildAxiosRequestOptions({
                headers: githubHeaders(),
                timeout: 10000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            'GitHub contents API'
        );
        const data = response.data as { content?: string; encoding?: string };
        if (response.status === 200 && data?.content && data.encoding === 'base64') {
            return Buffer.from(data.content.replace(/\s+/g, ''), 'base64').toString('utf8');
        }
    } catch {
        // fall through
    }
    return null;
}

export async function fetchTsconfigPaths(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<string[]> {
    try {
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
        const response = await requestDirectFirst(
            'GET',
            url,
            (forceDirect) => buildAxiosRequestOptions({
                headers: githubHeaders(),
                timeout: 10000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            'GitHub tree for tsconfig discovery'
        );
        if (response.status !== 200) return [];
        const data = response.data as { tree?: Array<{ path?: string }> };
        return (data.tree ?? [])
            .map((entry) => entry.path)
            .filter((filePath): filePath is string => typeof filePath === 'string')
            .filter((filePath) =>
                /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(filePath)
                && !filePath.includes('node_modules/')
            )
            .sort((left, right) => {
                const leftPriority = /(^|\/)(packages|apps|libs)\//.test(left) ? 0 : 1;
                const rightPriority = /(^|\/)(packages|apps|libs)\//.test(right) ? 0 : 1;
                return leftPriority - rightPriority || left.localeCompare(right);
            })
            .slice(0, 20);
    } catch {
        return [];
    }
}
