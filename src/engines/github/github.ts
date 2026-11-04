import { AppError } from '../../core/errors.js';
import { LineRange, parseLineRangeFromUrl } from './lineRange.js';
import {
    fetchGiteeBlob,
    fetchGiteeCommit,
    fetchGiteeCompare,
    fetchGiteeIssue,
    fetchGiteePullRequest,
    fetchGiteeReleases,
    fetchGiteeTree
} from './gitee.js';
import {
    fetchGithubCommit,
    fetchGithubCompare,
    fetchGithubReleases
} from './changes.js';
import {
    fetchGithubIssue,
    fetchGithubPullRequest
} from './discussion.js';
import {
    createMissingBlobError,
    fetchGithubBlob,
    fetchGithubTree
} from './content.js';
import {
    fetchReadme
} from './readme.js';
import {
    extractOwnerAndRepo,
    isRepoRoot
} from './parseHelpers.js';

// Re-exports for backward compatibility
export * from './format.js';
export * from './parseHelpers.js';
export * from './readme.js';
export * from './content.js';

/**
 * 全能 GitHub 内容提取入口：根据 URL 路径智能分流（README、源码、目录树、Issue、PR）
 * @param githubUrl GitHub / Gitee URL
 * @returns 格式化后的 Markdown 内容字符串，失败或 404 返回 null
 */
export async function fetchGithubContent(githubUrl: string, lineRange?: LineRange, releaseLimit = 10): Promise<string | null> {
    console.error(`\n--- Processing URL: ${githubUrl} ---`);

    if (!githubUrl?.trim()) {
        console.error('Invalid URL provided');
        return null;
    }

    const trimmed = githubUrl.trim();
    const effectiveRange = lineRange ?? parseLineRangeFromUrl(trimmed);
    if (effectiveRange && !/\/(?:blob)\//i.test(trimmed)) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            engine: 'github',
            message: 'lines / #L ranges are only supported for /blob/ source-file URLs.',
            hint: 'Open a file URL (/blob/<ref>/<path>) to use line ranges.'
        });
    }

    // 0. Gitee / GitHub 的 commit、compare、releases（结构化 API，不是 HTML 页面）
    const giteeCommitMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/commit\/([0-9a-f]{7,64})/i);
    if (giteeCommitMatch?.[1] && giteeCommitMatch[2] && giteeCommitMatch[3]) {
        return fetchGiteeCommit(giteeCommitMatch[1], giteeCommitMatch[2], giteeCommitMatch[3]);
    }
    const giteeCompareMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/compare\/([^?#\s]+?)\.\.\.([^?#\s]+)/i);
    if (giteeCompareMatch?.[1] && giteeCompareMatch[2] && giteeCompareMatch[3] && giteeCompareMatch[4]) {
        return fetchGiteeCompare(giteeCompareMatch[1], giteeCompareMatch[2], giteeCompareMatch[3], giteeCompareMatch[4]);
    }
    const giteeReleasesMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/releases(?:\/tag\/([^/?#\s]+))?/i);
    if (giteeReleasesMatch?.[1] && giteeReleasesMatch[2]) {
        return fetchGiteeReleases(giteeReleasesMatch[1], giteeReleasesMatch[2], giteeReleasesMatch[3], releaseLimit);
    }

    // 0. Gitee 的 GitHub 同款资源（blob / tree / issue / pull request）
    const giteeBlobMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/blob\/([^\/\s]+)\/(.+)/i);
    if (giteeBlobMatch && giteeBlobMatch[1] && giteeBlobMatch[2] && giteeBlobMatch[3] && giteeBlobMatch[4]) {
        const owner = giteeBlobMatch[1];
        const repo = giteeBlobMatch[2];
        const ref = giteeBlobMatch[3];
        const filePath = giteeBlobMatch[4].replace(/[?#].*$/, '');
        console.error(`🧭 Detected Gitee source file: ${owner}/${repo} @ ${ref}:${filePath}`);
        return fetchGiteeBlob(owner, repo, ref, filePath, effectiveRange);
    }

    const giteeTreeMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/tree\/([^\/\s]+)(?:\/(.+))?/i);
    if (giteeTreeMatch && giteeTreeMatch[1] && giteeTreeMatch[2] && giteeTreeMatch[3]) {
        const owner = giteeTreeMatch[1];
        const repo = giteeTreeMatch[2];
        const ref = giteeTreeMatch[3];
        const dirPath = giteeTreeMatch[4]?.replace(/[?#].*$/, '') || undefined;
        console.error(`🧭 Detected Gitee directory tree: ${owner}/${repo} @ ${ref}${dirPath ? ` /${dirPath}` : ''}`);
        return fetchGiteeTree(owner, repo, ref, dirPath);
    }

    const giteeIssueMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/issues\/([^\/?#\s]+)/i);
    if (giteeIssueMatch && giteeIssueMatch[1] && giteeIssueMatch[2] && giteeIssueMatch[3]) {
        const owner = giteeIssueMatch[1];
        const repo = giteeIssueMatch[2];
        const issueNumber = giteeIssueMatch[3];
        console.error(`🧭 Detected Gitee issue: ${owner}/${repo} #${issueNumber}`);
        return fetchGiteeIssue(owner, repo, issueNumber);
    }

    const giteePullMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^\/\s]+)\/([^\/\s]+)\/pulls?\/(\d+)/i);
    if (giteePullMatch && giteePullMatch[1] && giteePullMatch[2] && giteePullMatch[3]) {
        const owner = giteePullMatch[1];
        const repo = giteePullMatch[2];
        const prNumber = giteePullMatch[3];
        console.error(`🧭 Detected Gitee pull request: ${owner}/${repo} #${prNumber}`);
        return fetchGiteePullRequest(owner, repo, prNumber);
    }

    // 1. GitHub commit / compare / releases（结构化 API，优先于 HTML 页面）
    const githubCommitMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/commit\/([0-9a-f]{7,64})/i);
    if (githubCommitMatch?.[1] && githubCommitMatch[2] && githubCommitMatch[3]) {
        return fetchGithubCommit(githubCommitMatch[1], githubCommitMatch[2], githubCommitMatch[3]);
    }
    const githubCompareMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/compare\/([^?#\s]+?)\.\.\.([^?#\s]+)/i);
    if (githubCompareMatch?.[1] && githubCompareMatch[2] && githubCompareMatch[3] && githubCompareMatch[4]) {
        return fetchGithubCompare(githubCompareMatch[1], githubCompareMatch[2], githubCompareMatch[3], githubCompareMatch[4]);
    }
    const githubReleasesMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/releases(?:\/(?:tag\/)?([^/?#\s]+))?/i);
    if (githubReleasesMatch?.[1] && githubReleasesMatch[2]) {
        return fetchGithubReleases(githubReleasesMatch[1], githubReleasesMatch[2], githubReleasesMatch[3], releaseLimit);
    }

    // 2. 匹配 GitHub blob 源码文件链接：https://github.com/{owner}/{repo}/blob/{branch}/{path}
    const blobMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/blob\/([^\/\s]+)\/(.+)/i);
    if (blobMatch && blobMatch[1] && blobMatch[2] && blobMatch[3] && blobMatch[4]) {
        const owner = blobMatch[1];
        const repo = blobMatch[2];
        const branch = blobMatch[3];
        const filePath = blobMatch[4].replace(/[?#].*$/, '');
        console.error(`🧭 Detected GitHub source file: ${owner}/${repo} @ ${branch}:${filePath}`);
        const blobOutcome = await fetchGithubBlob(owner, repo, branch, filePath, effectiveRange);
        if (blobOutcome.status === 'ok') {
            return blobOutcome.content;
        }
        if (blobOutcome.status === 'notfound') {
            throw await createMissingBlobError(owner, repo, branch, filePath);
        }
        throw new AppError({
            code: 'network_error',
            retryable: true,
            engine: 'github',
            message: `Failed to fetch GitHub file ${owner}/${repo}@${branch}/${filePath}: ${blobOutcome.message}`
        });
    }

    // 2. 匹配 GitHub tree 目录链接：https://github.com/{owner}/{repo}/tree/{branch}(/{path})?
    const treeMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/tree\/([^\/\s]+)(?:\/(.+))?/i);
    if (treeMatch && treeMatch[1] && treeMatch[2] && treeMatch[3]) {
        const owner = treeMatch[1];
        const repo = treeMatch[2];
        const ref = treeMatch[3];
        const dirPath = treeMatch[4]?.replace(/[?#].*$/, '') || undefined;
        console.error(`🧭 Detected GitHub directory tree: ${owner}/${repo} @ ${ref}${dirPath ? ` /${dirPath}` : ''}`);
        const treeOutcome = await fetchGithubTree(owner, repo, ref, dirPath);
        if (treeOutcome.status === 'ok') {
            return treeOutcome.content;
        }
        if (treeOutcome.status === 'notfound') {
            throw new AppError({
                code: 'not_found',
                retryable: false,
                status: 404,
                engine: 'github',
                message: `GitHub tree not found: ${owner}/${repo}@${ref}${dirPath ? `/${dirPath}` : ''}`,
                hint: `目录或 ref 不存在：${owner}/${repo}@${ref}${dirPath ? `/${dirPath}` : ''}。请确认 ref 是分支/tag/commit；可先抓 https://github.com/${owner}/${repo}/tree/${ref} 查看实际目录。`
            });
        }
        throw new AppError({
            code: 'network_error',
            retryable: true,
            engine: 'github',
            message: `Failed to fetch GitHub tree ${owner}/${repo}@${ref}: ${treeOutcome.message}`
        });
    }

    // 3. 匹配 GitHub Issue 链接：https://github.com/{owner}/{repo}/issues/{number}
    const issueMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/issues\/(\d+)/i);
    if (issueMatch && issueMatch[1] && issueMatch[2] && issueMatch[3]) {
        const owner = issueMatch[1];
        const repo = issueMatch[2];
        const issueNumber = issueMatch[3];
        console.error(`🧭 Detected GitHub issue: ${owner}/${repo} #${issueNumber}`);
        return fetchGithubIssue(owner, repo, issueNumber);
    }

    // 4. 匹配 GitHub Pull Request 链接：https://github.com/{owner}/{repo}/pull/{number}
    const pullMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)\/pull\/(\d+)/i);
    if (pullMatch && pullMatch[1] && pullMatch[2] && pullMatch[3]) {
        const owner = pullMatch[1];
        const repo = pullMatch[2];
        const prNumber = pullMatch[3];
        console.error(`🧭 Detected GitHub pull request: ${owner}/${repo} #${prNumber}`);
        return fetchGithubPullRequest(owner, repo, prNumber);
    }

    // 5. 默认仓库 README 抓取流程
    // 注意：仅当 URL 路径恰好为仓库根目录（如 :owner/:repo 或 /:owner/:repo/）时，才抓取 README。
    // 若包含 /releases, /stargazers, /commits 等子路径，返回 null，交由通用网页抓取器提取实际页面正文！
    if (!isRepoRoot(trimmed)) {
        console.error(`Not a repository root or supported subresource (e.g. releases/commits/stargazers), skipping GitHub specialized extractor`);
        return null;
    }

    const repoInfo = extractOwnerAndRepo(githubUrl);
    if (!repoInfo) {
        console.error(`Unable to extract owner and repo from URL: ${githubUrl}`);
        return null;
    }

    console.error(`🧭 Extraction successful: ${repoInfo.owner}/${repoInfo.repo} (${repoInfo.host})`);
    const content = await fetchReadme(repoInfo.owner, repoInfo.repo, repoInfo.host);
    if (content) {
        console.error(`🧭 README fetched successfully (${content.length} characters)`);
        return content;
    } else {
        console.warn(`🧭 Failed to fetch README for ${repoInfo.owner}/${repoInfo.repo}`);
        return null;
    }
}

/**
 * 向后兼容别名：保留 fetchGithubReadme 导出以供现有代码/单测使用
 */
export const fetchGithubReadme = fetchGithubContent;
