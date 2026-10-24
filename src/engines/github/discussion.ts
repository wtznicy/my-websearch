import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { formatChangedFilesSection } from './contentBudget.js';
/**
 * 通过 GitHub REST API 获取 Issue 详情与评论讨论（免 key 10次/分，支持 GITHUB_TOKEN）。
 */
export async function fetchGithubIssue(
    owner: string,
    repo: string,
    issueNumber: string
): Promise<string | null> {
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const numEnc = encodeURIComponent(issueNumber.trim());

    try {
        const headers: Record<string, string> = {
            'User-Agent': 'GitHub-Issue-Fetcher/1.0',
            'Accept': 'application/vnd.github.v3+json',
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
        };

        const issueUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/issues/${numEnc}`;
        const issueRes = await requestDirectFirst('GET', issueUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                headers,
                timeout: 10000,
                forceDirect
            })
        }), 'GitHub Issue API');

        if (issueRes.status === 404) {
            return null;
        }

        const issueData = issueRes.data as {
            number: number;
            title: string;
            state: string;
            user?: { login: string };
            created_at: string;
            body?: string;
            html_url: string;
            comments?: number;
            reactions?: { total_count?: number; '+1'?: number; 'heart'?: number };
        };

        const lines: string[] = [
            `# Issue #${issueData.number}: ${issueData.title}`,
            `- **Status**: ${issueData.state.toUpperCase()}`,
            `- **Author**: @${issueData.user?.login ?? 'unknown'}`,
            `- **Created**: ${issueData.created_at}`,
            `- **URL**: ${issueData.html_url}`
        ];

        if (issueData.reactions && typeof issueData.reactions.total_count === 'number' && issueData.reactions.total_count > 0) {
            lines.push(`- **Reactions**: 👍 ${issueData.reactions['+1'] ?? 0} ❤️ ${issueData.reactions['heart'] ?? 0} (total: ${issueData.reactions.total_count})`);
        }

        lines.push('', '## Description', issueData.body?.trim() || '_No description provided._');

        // 尝试抓取前 15 条评论
        if (issueData.comments && issueData.comments > 0) {
            try {
                const commentsUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/issues/${numEnc}/comments?per_page=15`;
                const commentsRes = await requestDirectFirst('GET', commentsUrl, (forceDirect) => ({
                    ...buildAxiosRequestOptions({
                        headers,
                        timeout: 10000,
                        forceDirect
                    })
                }), 'GitHub Issue Comments API');

                const comments = commentsRes.data as Array<{
                    user?: { login: string };
                    created_at: string;
                    body?: string;
                }>;

                if (Array.isArray(comments) && comments.length > 0) {
                    lines.push('', `## Discussion (${comments.length} comments)`);
                    for (let idx = 0; idx < comments.length; idx += 1) {
                        const c = comments[idx];
                        if (c) {
                            lines.push(
                                '',
                                `### Comment ${idx + 1} by @${c.user?.login ?? 'unknown'} (${c.created_at})`,
                                c.body?.trim() || '_Empty comment_'
                            );
                        }
                    }
                }
            } catch (commentErr) {
                console.warn(`Failed to fetch comments for issue #${issueNumber}:`, commentErr instanceof Error ? commentErr.message : String(commentErr));
            }
        }

        return lines.join('\n');
    } catch (error) {
        console.error(`Failed to fetch issue #${issueNumber} for ${owner}/${repo}:`, error instanceof Error ? error.message : String(error));
        return null;
    }
}

/**
 * 通过 GitHub REST API 获取 Pull Request 详情与变更文件列表。
 */
export async function fetchGithubPullRequest(
    owner: string,
    repo: string,
    prNumber: string
): Promise<string | null> {
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const numEnc = encodeURIComponent(prNumber.trim());

    try {
        const headers: Record<string, string> = {
            'User-Agent': 'GitHub-PR-Fetcher/1.0',
            'Accept': 'application/vnd.github.v3+json',
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
        };

        const prUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/pulls/${numEnc}`;
        const prRes = await requestDirectFirst('GET', prUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                headers,
                timeout: 10000,
                forceDirect
            })
        }), 'GitHub Pull Request API');

        if (prRes.status === 404) {
            return null;
        }

        const prData = prRes.data as {
            number: number;
            title: string;
            state: string;
            merged?: boolean;
            merged_at?: string;
            user?: { login: string };
            created_at: string;
            body?: string;
            html_url: string;
            base?: { ref: string };
            head?: { ref: string };
            additions?: number;
            deletions?: number;
            changed_files?: number;
        };

        const statusLabel = prData.merged ? 'MERGED' : (prData.state || 'OPEN').toUpperCase();
        const lines: string[] = [
            `# Pull Request #${prData.number}: ${prData.title}`,
            `- **Status**: ${statusLabel}`,
            `- **Author**: @${prData.user?.login ?? 'unknown'}`,
            `- **Branch**: \`${prData.head?.ref ?? 'head'}\` -> \`${prData.base?.ref ?? 'base'}\``,
            `- **Changes**: +${prData.additions ?? 0} -${prData.deletions ?? 0} across ${prData.changed_files ?? 0} files`,
            `- **Created**: ${prData.created_at}${prData.merged_at ? ` (Merged: ${prData.merged_at})` : ''}`,
            `- **URL**: ${prData.html_url}`,
            '',
            '## Description',
            prData.body?.trim() || '_No description provided._'
        ];

        // 尝试获取修改的文件清单
        try {
            // per_page=100 是 GitHub 的上限：拿更多文件名用于「… and N more」的准确计数，
            // 展示层再截到前 30 个（列表级截断，避免被全局字符上限砍在半行）。
            const filesUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/pulls/${numEnc}/files?per_page=100`;
            const filesRes = await requestDirectFirst('GET', filesUrl, (forceDirect) => ({
                ...buildAxiosRequestOptions({
                    headers,
                    timeout: 10000,
                    forceDirect
                })
            }), 'GitHub PR Files API');

            const files = filesRes.data as Array<{
                filename: string;
                status: string;
                additions: number;
                deletions: number;
            }>;

            if (Array.isArray(files) && files.length > 0) {
                lines.push(...formatChangedFilesSection(files, prData.changed_files ?? files.length));
            }
        } catch (filesErr) {
            console.warn(`Failed to fetch changed files for PR #${prNumber}:`, filesErr instanceof Error ? filesErr.message : String(filesErr));
        }

        return lines.join('\n');
    } catch (error) {
        console.error(`Failed to fetch PR #${prNumber} for ${owner}/${repo}:`, error instanceof Error ? error.message : String(error));
        return null;
    }
}
