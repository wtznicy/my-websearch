export type RepoHost = 'github' | 'gitee';

export function extractOwnerAndRepo(url: string): { owner: string; repo: string; host: RepoHost } | null {
    const trimmed = url.trim();

    // 匹配 SSH 格式：git@github.com:owner/repo.git 或 git@gitee.com:owner/repo.git
    const sshMatch = trimmed.match(/^git@(github|gitee)\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (sshMatch && sshMatch[1] && sshMatch[2] && sshMatch[3]) {
        return {
            host: sshMatch[1].toLowerCase() as RepoHost,
            owner: sshMatch[2],
            repo: sshMatch[3]
        };
    }

    // 匹配 HTTPS 格式
    const match = trimmed.match(/(?:https?:\/\/)?(?:www\.)?(github|gitee)\.com\/([^\/\s]+)\/([^\/\s]+)/i);
    if (!match || !match[1] || !match[2] || !match[3]) {
        return null;
    }

    const host = match[1].toLowerCase() as RepoHost;
    const owner = match[2];
    const rawRepo = match[3];

    // 清理可能的 .git 后缀或 URL fragment/query
    const repo = rawRepo.replace(/\.git$/i, '').replace(/[?#].*$/, '');

    return { host, owner, repo };
}

export function isRepoRoot(urlStr: string): boolean {
    try {
        if (/^git@(github|gitee)\.com:[^/]+\/[^/]+(?:\.git)?$/i.test(urlStr.trim())) {
            return true;
        }
        const parsed = new URL(urlStr.trim());
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts.length === 2;
    } catch {
        return false;
    }
}
