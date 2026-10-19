import { Buffer } from 'node:buffer';
import type { AxiosResponse } from 'axios';
import { AppError } from '../../core/errors.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';
import { formatSourceFile, renderAsciiTree } from './format.js';

const GITEE_API = 'https://gitee.com/api/v5';
const GITEE_TIMEOUT_MS = 12000;
const MAX_TREE_ITEMS = 150;

type GiteeContentsFile = {
    type?: string;
    encoding?: string;
    size?: number;
    name?: string;
    path?: string;
    content?: string;
    download_url?: string;
    html_url?: string;
};

type GiteeTreeItem = { path: string; type: 'blob' | 'tree'; size?: number };

function giteeHeaders(): Record<string, string> {
    return {
        'User-Agent': DEFAULT_DESKTOP_UA,
        'Accept': 'application/json',
        // Gitee API 支持 Authorization: token；匿名也可读公开仓库，token 仅提升限额/私有仓库。
        ...(process.env.GITEE_TOKEN ? { Authorization: `token ${process.env.GITEE_TOKEN}` } : {})
    };
}

async function giteeGet(url: string, label: string): Promise<AxiosResponse> {
    return requestDirectFirst('GET', url, (forceDirect) => ({
        ...buildAxiosRequestOptions({
            headers: giteeHeaders(),
            forceDirect,
            timeout: GITEE_TIMEOUT_MS
        }),
        validateStatus: (status: number) => status >= 200 && status < 500
    }), label);
}

function throwGiteeStatus(status: number, label: string): never {
    throw new AppError({
        code: status === 429 ? 'rate_limited' : 'engine_error',
        retryable: status === 429 || status >= 500,
        status,
        engine: 'gitee',
        message: `Gitee API ${label} failed with HTTP ${status}`
    });
}

function giteeNotFound(message: string, hint: string): AppError {
    return new AppError({
        code: 'not_found',
        retryable: false,
        status: 404,
        engine: 'gitee',
        message,
        hint
    });
}

function encodePath(filePath: string): string {
    return filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function fetchGiteeSiblingNames(owner: string, repo: string, ref: string, filePath: string): Promise<string[]> {
    const dirPath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    if (!dirPath) {
        return [];
    }
    const url = `${GITEE_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(dirPath)}?ref=${encodeURIComponent(ref)}`;
    try {
        const res = await giteeGet(url, 'contents');
        if (res.status !== 200 || !Array.isArray(res.data)) {
            return [];
        }
        return (res.data as Array<{ name?: unknown; type?: unknown }>)
            .filter((item) => item.type === 'file' && typeof item.name === 'string')
            .map((item) => item.name as string)
            .slice(0, 12);
    } catch {
        return [];
    }
}

async function createGiteeMissingBlobError(
    owner: string,
    repo: string,
    ref: string,
    filePath: string
): Promise<AppError> {
    const dirPath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const dirSuffix = dirPath ? `/${dirPath}` : '';
    const treeUrl = `https://gitee.com/${owner}/${repo}/tree/${ref}${dirSuffix}`;
    const siblings = await fetchGiteeSiblingNames(owner, repo, ref, filePath);
    const hint = siblings.length > 0
        ? `文件不存在：${owner}/${repo}@${ref}${dirSuffix}/${filePath.split('/').pop() ?? filePath}。该目录下可读文件：${siblings.slice(0, 8).join(', ')}${siblings.length > 8 ? ` 等 ${siblings.length} 个` : ''}。示例 URL：https://gitee.com/${owner}/${repo}/blob/${ref}${dirSuffix}/${siblings[0]}；或先看目录：${treeUrl}。`
        : `文件不存在：${owner}/${repo}@${ref}${dirSuffix}/${filePath.split('/').pop() ?? filePath}。请确认 ref（分支/tag/commit）与路径；可先读取目录：${treeUrl}。`;
    return giteeNotFound(`Gitee file not found: ${owner}/${repo}@${ref}/${filePath}`, hint);
}

export async function fetchGiteeBlob(owner: string, repo: string, ref: string, filePath: string): Promise<string> {
    const cleanPath = filePath.replace(/[?#].*$/, '');
    const url = `${GITEE_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(cleanPath)}?ref=${encodeURIComponent(ref)}`;
    const res = await giteeGet(url, 'contents');
    if (res.status === 404) {
        throw await createGiteeMissingBlobError(owner, repo, ref, cleanPath);
    }
    if (res.status >= 400) {
        throwGiteeStatus(res.status, 'contents');
    }

    const data = res.data as GiteeContentsFile;
    if (data?.type !== 'file') {
        throw giteeNotFound(
            `Gitee path is not a file: ${owner}/${repo}@${ref}/${cleanPath}`,
            `该路径是目录或不存在；列目录请使用 /tree/${ref}/${cleanPath}。`
        );
    }

    let content = typeof data.content === 'string'
        ? Buffer.from(data.content, 'base64').toString('utf8')
        : '';

    // 大文件（或 API 未内联 content）时走 raw/download_url 兜底；Gitee 会 302 到 raw.giteeusercontent.com。
    if (!content && typeof data.download_url === 'string') {
        const raw = await requestDirectFirst('GET', data.download_url, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                headers: { 'User-Agent': DEFAULT_DESKTOP_UA },
                forceDirect,
                timeout: 15000,
                responseType: 'text'
            }),
            validateStatus: (status: number) => status >= 200 && status < 500
        }), 'Gitee raw file');
        if (raw.status >= 400) {
            throwGiteeStatus(raw.status, 'raw');
        }
        content = typeof raw.data === 'string' ? raw.data : String(raw.data ?? '');
    }

    if (!content) {
        throw new AppError({
            code: 'empty_content',
            retryable: false,
            engine: 'gitee',
            message: `Gitee returned empty content for ${owner}/${repo}@${ref}/${cleanPath}`
        });
    }

    return formatSourceFile(owner, repo, ref, cleanPath, content);
}

export async function fetchGiteeTree(owner: string, repo: string, ref: string, dirPath?: string): Promise<string> {
    const url = `${GITEE_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const res = await giteeGet(url, 'git trees');
    if (res.status === 404) {
        throw giteeNotFound(
            `Gitee tree not found: ${owner}/${repo}@${ref}`,
            `目录或 ref 不存在：${owner}/${repo}@${ref}。请确认 ref 是分支/tag/commit；可先读取仓库根 README。`
        );
    }
    if (res.status >= 400) {
        throwGiteeStatus(res.status, 'git trees');
    }

    const data = res.data as { tree?: GiteeTreeItem[]; truncated?: boolean };
    const normalizedDirPath = dirPath ? dirPath.replace(/^\/+|\/+$/g, '') : '';
    let items = Array.isArray(data?.tree) ? data.tree : [];

    if (normalizedDirPath) {
        const prefix = `${normalizedDirPath}/`;
        items = items
            .filter((item) => item.path !== normalizedDirPath && item.path.startsWith(prefix))
            .map((item) => ({
                ...item,
                path: item.path.slice(prefix.length),
                size: item.type === 'blob' ? item.size : undefined
            }))
            .filter((item) => item.path.length > 0);
    }

    if (normalizedDirPath && items.length === 0 && !data.truncated) {
        throw giteeNotFound(
            `Gitee tree path not found: ${owner}/${repo}@${ref}/${normalizedDirPath}`,
            `目录不存在：${owner}/${repo}@${ref}/${normalizedDirPath}。请确认路径，或先抓 /tree/${ref} 查看目录。`
        );
    }

    const totalItemsCount = items.length;
    const isCapped = totalItemsCount > MAX_TREE_ITEMS;
    const displayItems = isCapped ? items.slice(0, MAX_TREE_ITEMS) : items;
    const renderedTree = renderAsciiTree(displayItems);
    const header = `# Directory Tree: ${owner}/${repo} @ ${ref}${normalizedDirPath ? ` (subpath: /${normalizedDirPath})` : ''}\n\nTotal items: ${totalItemsCount}${isCapped ? ` (showing first ${MAX_TREE_ITEMS})` : ''}\n\n`;
    const truncationNotice = isCapped ? `\n\n... and ${totalItemsCount - MAX_TREE_ITEMS} more items.` : '';

    return `${header}\`\`\`\n${renderedTree}\n\`\`\`${truncationNotice}`;
}

type GiteeIssue = {
    number?: string | number;
    title?: string;
    state?: string;
    user?: { login?: string };
    created_at?: string;
    html_url?: string;
    body?: string;
    comments?: number;
    labels?: Array<{ name?: string }>;
};

export async function fetchGiteeIssue(owner: string, repo: string, issueNumber: string): Promise<string> {
    const base = `${GITEE_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(issueNumber)}`;
    const res = await giteeGet(base, 'issue');
    if (res.status === 404) {
        throw giteeNotFound(
            `Gitee issue not found: ${owner}/${repo}#${issueNumber}`,
            '确认 Issue 编号（Gitee 常见形如 IDLSUI）与仓库 URL。'
        );
    }
    if (res.status >= 400) {
        throwGiteeStatus(res.status, 'issue');
    }

    const issue = res.data as GiteeIssue;
    let comments: Array<{ user?: { login?: string }; created_at?: string; body?: string }> = [];
    if ((issue.comments ?? 0) > 0) {
        const commentsRes = await giteeGet(`${base}/comments?per_page=15`, 'issue comments');
        if (commentsRes.status === 200 && Array.isArray(commentsRes.data)) {
            comments = commentsRes.data;
        }
    }

    const lines: string[] = [];
    lines.push(`# Issue #${issue.number ?? issueNumber}: ${issue.title ?? '(no title)'}`);
    lines.push(`- **Status**: ${(issue.state ?? 'unknown').toUpperCase()}`);
    if (issue.user?.login) lines.push(`- **Author**: @${issue.user.login}`);
    if (issue.created_at) lines.push(`- **Created**: ${issue.created_at}`);
    if (issue.html_url) lines.push(`- **URL**: ${issue.html_url}`);
    if (issue.labels && issue.labels.length > 0) {
        lines.push(`- **Labels**: ${issue.labels.map((label) => label.name).filter(Boolean).join(', ')}`);
    }
    lines.push('');
    lines.push('## Description');
    lines.push(issue.body?.trim() || '_No description provided._');

    if (comments.length > 0) {
        lines.push('');
        lines.push(`## Discussion (${comments.length} comments)`);
        comments.forEach((comment, index) => {
            lines.push('');
            lines.push(`### Comment ${index + 1} by @${comment.user?.login ?? 'unknown'} (${comment.created_at ?? 'unknown'})`);
            lines.push(comment.body?.trim() || '_No content._');
        });
    }

    return lines.join('\n');
}

type GiteePullRequest = {
    number?: number;
    title?: string;
    state?: string;
    user?: { login?: string };
    created_at?: string;
    html_url?: string;
    body?: string;
    head?: { ref?: string };
    base?: { ref?: string };
    merged_at?: string | null;
};

type GiteePullFile = {
    filename?: string;
    additions?: number | string;
    deletions?: number | string;
    status?: string | null;
};

export async function fetchGiteePullRequest(owner: string, repo: string, prNumber: string | number): Promise<string> {
    const base = `${GITEE_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(String(prNumber))}`;
    const res = await giteeGet(base, 'pull request');
    if (res.status === 404) {
        throw giteeNotFound(
            `Gitee pull request not found: ${owner}/${repo}!${prNumber}`,
            '确认 PR 编号与仓库 URL（Gitee PR 路径是 /pulls/<number>）。'
        );
    }
    if (res.status >= 400) {
        throwGiteeStatus(res.status, 'pull request');
    }

    const pr = res.data as GiteePullRequest;
    let files: GiteePullFile[] = [];
    try {
        const filesRes = await giteeGet(`${base}/files?per_page=30`, 'pull request files');
        if (filesRes.status === 200 && Array.isArray(filesRes.data)) {
            files = filesRes.data;
        }
    } catch {
        // 变更文件列表失败不应否决 PR 主体信息
    }

    const additions = files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0);
    const deletions = files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0);

    const lines: string[] = [];
    lines.push(`# Pull Request #${pr.number ?? prNumber}: ${pr.title ?? '(no title)'}`);
    lines.push(`- **Status**: ${(pr.state ?? 'unknown').toUpperCase()}${pr.merged_at ? ` (merged: ${pr.merged_at})` : ''}`);
    if (pr.user?.login) lines.push(`- **Author**: @${pr.user.login}`);
    if (pr.head?.ref || pr.base?.ref) lines.push(`- **Branch**: \`${pr.head?.ref ?? '?'}\` -> \`${pr.base?.ref ?? '?'}\``);
    if (files.length > 0) {
        lines.push(`- **Changes**: +${additions} -${deletions} across ${files.length} files`);
    }
    if (pr.created_at) lines.push(`- **Created**: ${pr.created_at}`);
    if (pr.html_url) lines.push(`- **URL**: ${pr.html_url}`);
    lines.push('');
    lines.push('## Description');
    lines.push(pr.body?.trim() || '_No description provided._');

    if (files.length > 0) {
        lines.push('');
        lines.push(`## Changed Files (${files.length})`);
        for (const file of files) {
            const status = file.status ? `, status: ${file.status}` : '';
            lines.push(`- \`${file.filename ?? 'unknown'}\` (+${file.additions ?? 0}, -${file.deletions ?? 0}${status})`);
        }
    }

    return lines.join('\n');
}
