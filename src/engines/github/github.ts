import { buildAxiosRequestOptions, requestWithSafeRedirects } from '../../utils/httpRequest.js';

// Avoid the GitHub README API here because anonymous API requests in this
// environment hit rate limits quickly; raw URLs are more stable for this tool.
const README_CANDIDATES = [
    'README.md',
    'README.mdx',
    'README.markdown',
    'README',
    'README.txt',
    'readme.md',
    'readme.mdx',
    'readme.markdown',
    'readme',
    'readme.txt'
];

const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com';
// jsDelivr mirrors GitHub repo files on a global CDN that stays reachable in
// networks where raw.githubusercontent.com DNS is polluted or blocked.
// URL shape: https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{file}
// An empty ref uses the repository's default branch.
const JSDELIVR_CDN_BASE = 'https://cdn.jsdelivr.net/gh';
const JSDELIVR_REF_CANDIDATES = ['', '@main', '@master'];

// Set GITHUB_README_CDN_FIRST=true to skip raw.githubusercontent.com and go
// straight to the jsDelivr CDN (useful when GitHub is unreachable).
const cdnFirst = process.env.GITHUB_README_CDN_FIRST === 'true';

type ReadmeFetchOutcome =
    | { status: 'ok'; content: string }
    | { status: 'notfound' }
    | { status: 'error'; message: string };

/**
 * Fetch one README candidate URL and classify the outcome.
 * @param url Candidate URL to fetch
 * @param label Source label for logs ('raw' or 'jsDelivr')
 * @param timeout Request timeout in ms
 */
async function fetchReadmeSource(url: string, label: string, timeout: number): Promise<ReadmeFetchOutcome> {
    try {
        console.error(`Fetching README from ${label}: ${url}`);

        // 走统一的安全重定向链路：raw 是代码固定生成的可信 host（禁用重定向、绕过通用 DNS 私网过滤，
        // 避免部分网络把 GitHub raw 域名解析到 100.64.0.0/10 代理地址时误判为 SSRF）；
        // jsDelivr CDN 走标准过滤 agent + 每跳 DNS 校验（保持 SSRF 防护）。
        const response = await requestWithSafeRedirects('GET', url, {
            ...buildAxiosRequestOptions({
                headers: {
                    'User-Agent': 'GitHub-README-Fetcher/1.0'
                },
                trustedStaticHost: label === 'raw',
                timeout,
                responseType: 'text',
                validateStatus: (status) => status === 200 || status === 404
            })
        }, label === 'raw' ? 'raw.githubusercontent.com' : 'jsDelivr CDN');

        if (response.status === 404) {
            return { status: 'notfound' };
        }

        if (typeof response.data === 'string' && response.data.trim()) {
            return { status: 'ok', content: response.data };
        }

        return { status: 'error', message: 'Empty or invalid README content' };
    } catch (error: any) {
        const isTimeout = error?.code === 'ECONNABORTED';
        const status = typeof error?.response?.status === 'number' ? error.response.status : undefined;
        const message = error instanceof Error ? error.message : String(error);

        if (isTimeout) {
            console.error(`Timeout fetching README from ${label}: ${url}`);
        } else if (status !== undefined) {
            console.error(`Failed to fetch README from ${label}: ${url} (HTTP ${status}):`, message);
        } else {
            console.error(`Network error fetching README from ${label}: ${url}:`, message);
        }

        return { status: 'error', message };
    }
}

/**
 * GitHub README Fetcher - Extract repo info from URLs and fetch README content
 */

/**
 * Extract owner and repo name from GitHub URLs
 * Supports HTTPS, SSH, and URLs with query params/fragments
 * @param url GitHub repository URL
 * @returns {owner, repo} object or null if invalid
 */
function extractOwnerAndRepo(url: string): { owner: string; repo: string } | null {
    try {
        const trimmedUrl = url.trim();

        // Regex patterns for HTTPS and SSH URLs
        const patterns = [
            /(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)/i,
            /git@github\.com:([^\/\s]+)\/([^\/\s]+)\.git/i
        ];

        for (const pattern of patterns) {
            const match = trimmedUrl.match(pattern);
            if (match) {
                const [, owner, rawRepo] = match;

                // Clean repo name: remove query params, fragments, .git suffix, paths
                const repo = rawRepo.replace(/(?:[?#].*$|\.git$|\/.*$)/g, '');
                if (owner && repo && owner.length > 0 && repo.length > 0) {
                    return { owner: owner.trim(), repo: repo.trim() };
                }
            }
        }

        return null;
    } catch (error) {
        console.warn('Failed to parse GitHub URL:', url, error);
        return null;
    }
}

/**
 * Fetch README content from GitHub repository raw URLs
 * @param owner Repository owner (username or org)
 * @param repo Repository name
 * @returns README content string or null if failed
 */
async function fetchReadme(owner: string, repo: string): Promise<string | null> {
    if (!owner?.trim() || !repo?.trim()) {
        console.error('Invalid owner or repo name provided');
        return null;
    }

    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    let rawUnreachable = false;
    let sawFetchFailure = false;

    for (const readmeFile of README_CANDIDATES) {
        // 1) Try raw.githubusercontent.com first, unless CDN-first is forced or
        //    a previous candidate proved the raw host unreachable.
        if (!cdnFirst && !rawUnreachable) {
            const rawUrl = `${RAW_GITHUB_BASE}/${ownerEnc}/${repoEnc}/HEAD/${readmeFile}`;
            const rawResult = await fetchReadmeSource(rawUrl, 'raw', 10000);

            if (rawResult.status === 'ok') {
                return rawResult.content;
            }
            if (rawResult.status === 'error') {
                sawFetchFailure = true;
                // Domain-level failure: later candidates should not retry the raw host.
                rawUnreachable = true;
            }
        }

        // 2) Fall back to the jsDelivr CDN mirror (default branch, then main/master).
        for (const ref of JSDELIVR_REF_CANDIDATES) {
            const cdnUrl = `${JSDELIVR_CDN_BASE}/${ownerEnc}/${repoEnc}${ref}/${readmeFile}`;
            const cdnResult = await fetchReadmeSource(cdnUrl, 'jsDelivr', 10000);

            if (cdnResult.status === 'ok') {
                return cdnResult.content;
            }
            if (cdnResult.status === 'error') {
                sawFetchFailure = true;
            }
        }
    }

    if (sawFetchFailure) {
        console.warn(`Failed to fetch README for ${owner}/${repo}`);
    } else {
        console.warn(`README not found for ${owner}/${repo}`);
    }

    return null;
}

/**
 * Main function: parse URL and fetch README content
 * @param githubUrl GitHub repository URL
 * @returns README content or null if failed
 */
async function getReadmeFromUrl(githubUrl: string): Promise<string | null> {
    console.error(`\n--- Processing URL: ${githubUrl} ---`);

    if (!githubUrl?.trim()) {
        console.error('Invalid URL provided');
        return null;
    }

    const repoInfo = extractOwnerAndRepo(githubUrl);

    if (!repoInfo) {
        console.error(`Unable to extract owner and repo from URL: ${githubUrl}`);
        return null;
    }

    console.error(`✅ Extraction successful: ${repoInfo.owner}/${repoInfo.repo}`);

    const content = await fetchReadme(repoInfo.owner, repoInfo.repo);

    if (content) {
        console.error(`✅ README fetched successfully (${content.length} characters)`);
        return content;
    } else {
        console.warn(`❌ Failed to fetch README for ${repoInfo.owner}/${repoInfo.repo}`);
        return null;
    }
}

/**
 * Fetch README content from GitHub repository
 * @param githubUrl GitHub repository URL (supports HTTPS, SSH, with params)
 * @returns README content string or null if failed
 */
export async function fetchGithubReadme(githubUrl: string): Promise<string | null> {
    return getReadmeFromUrl(githubUrl);
}
