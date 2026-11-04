import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { AppError } from '../../core/errors.js';
import { getOptionalString } from '../../config/env.js';
import { formatSourceFile, renderAsciiTree } from './format.js';
import { LineRange } from './lineRange.js';
import { RAW_GITHUB_BASE, fetchReadmeSource, type ReadmeFetchOutcome } from './readme.js';
import {
    buildJsdelivrPath,
    createContentBudget,
    isBudgetExhausted,
    isGithubContentCdnFirst
} from './contentBudget.js';

export type BlobFetchOutcome =
    | { status: 'ok'; content: string }
    | { status: 'notfound' }
    | { status: 'error'; message: string };

export async function fetchGithubBlob(
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
    lineRange?: LineRange
): Promise<BlobFetchOutcome> {
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const cleanPath = filePath.split('/').map(encodeURIComponent).join('/');
    const branchEnc = encodeURIComponent(branch.trim());

    const cdnFirst = isGithubContentCdnFirst();
    const budget = createContentBudget();
    const cdnPath = buildJsdelivrPath(ownerEnc, repoEnc, `@${branchEnc}`, cleanPath);

    const tryCdn = async (): Promise<ReadmeFetchOutcome> => fetchReadmeSource({ kind: 'jsdelivr', path: cdnPath }, budget);
    const tryRaw = async (): Promise<ReadmeFetchOutcome> => fetchReadmeSource(
        { kind: 'raw', url: `${RAW_GITHUB_BASE}/${ownerEnc}/${repoEnc}/${branchEnc}/${cleanPath}` },
        budget
    );

    let rawResult: ReadmeFetchOutcome = { status: 'error', message: 'raw source skipped (CDN-first)' };
    let cdnResult: ReadmeFetchOutcome = { status: 'error', message: 'CDN source skipped' };

    if (cdnFirst) {
        cdnResult = await tryCdn();
        if (cdnResult.status === 'ok') {
            return { status: 'ok', content: formatSourceFile(owner, repo, branch, filePath, cdnResult.content, lineRange) };
        }
        if (!isBudgetExhausted(budget)) {
            rawResult = await tryRaw();
        }
    } else {
        rawResult = await tryRaw();
        if (rawResult.status === 'ok') {
            return { status: 'ok', content: formatSourceFile(owner, repo, branch, filePath, rawResult.content, lineRange) };
        }
        if (!isBudgetExhausted(budget)) {
            cdnResult = await tryCdn();
        }
    }

    if (rawResult.status === 'ok') {
        return { status: 'ok', content: formatSourceFile(owner, repo, branch, filePath, rawResult.content, lineRange) };
    }
    if (cdnResult.status === 'ok') {
        return { status: 'ok', content: formatSourceFile(owner, repo, branch, filePath, cdnResult.content, lineRange) };
    }

    const rawNotFound = rawResult.status === 'notfound'
        || (rawResult.status === 'error' && rawResult.httpStatus === 404);
    const cdnNotFound = cdnResult.status === 'notfound'
        || (cdnResult.status === 'error' && cdnResult.httpStatus === 404);
    if (rawNotFound || cdnNotFound) {
        return { status: 'notfound' };
    }

    const message = rawResult.status === 'error'
        ? rawResult.message
        : (cdnResult.status === 'error' ? cdnResult.message : 'empty or invalid response');
    return { status: 'error', message };
}

export async function fetchSiblingFileNames(
    owner: string,
    repo: string,
    ref: string,
    filePath: string
): Promise<string[]> {
    const dirPath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const refParam = encodeURIComponent(ref.trim());
    const contentsPath = dirPath
        ? `${dirPath.split('/').map(encodeURIComponent).join('/')}/`
        : '';
    const apiUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/contents/${contentsPath}?ref=${refParam}`;

    try {
        const headers: Record<string, string> = {
            'User-Agent': 'GitHub-Content-Fetcher/1.0',
            'Accept': 'application/vnd.github.v3+json',
            ...(getOptionalString('GITHUB_TOKEN') ? { Authorization: `Bearer ${getOptionalString('GITHUB_TOKEN')}` } : {})
        };
        const res = await requestDirectFirst('GET', apiUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({ headers, timeout: 8000, forceDirect })
        }), 'GitHub contents API');
        if (res.status !== 200 || !Array.isArray(res.data)) {
            return [];
        }
        return (res.data as Array<{ name?: unknown; type?: unknown }>)
            .filter((item) => item?.type === 'file' && typeof item.name === 'string')
            .map((item) => item.name as string)
            .slice(0, 12);
    } catch {
        return [];
    }
}

export async function createMissingBlobError(
    owner: string,
    repo: string,
    ref: string,
    filePath: string
): Promise<AppError> {
    const dirPath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const dirSuffix = dirPath ? `/${dirPath}` : '';
    const treeUrl = `https://github.com/${owner}/${repo}/tree/${ref}${dirSuffix}`;
    const siblings = await fetchSiblingFileNames(owner, repo, ref, filePath);

    const requestedBase = filePath.split('/').pop() ?? filePath;
    const pickClosestSibling = (names: string[]): string => {
        const requested = requestedBase.toLowerCase();
        let best = names[0]!;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const name of names) {
            const lower = name.toLowerCase();
            let prefix = 0;
            while (prefix < lower.length && prefix < requested.length && lower[prefix] === requested[prefix]) {
                prefix += 1;
            }
            const score = prefix * 10 - Math.abs(lower.length - requested.length);
            if (score > bestScore) {
                bestScore = score;
                best = name;
            }
        }
        return best;
    };

    let hint: string;
    if (siblings.length > 0) {
        const shown = siblings.slice(0, 8);
        const exampleUrl = `https://github.com/${owner}/${repo}/blob/${ref}${dirSuffix}/${pickClosestSibling(siblings)}`;
        hint = `文件不存在：${owner}/${repo}@${ref}${dirSuffix}/${filePath.split('/').pop() ?? filePath}。该目录下可读文件：${shown.join(', ')}${siblings.length > shown.length ? ` 等 ${siblings.length} 个` : ''}。示例 URL：${exampleUrl}；或先看目录：${treeUrl}。`;
    } else {
        hint = `文件不存在：${owner}/${repo}@${ref}${dirSuffix}/${filePath.split('/').pop() ?? filePath}。请确认 ref（分支/tag/commit）与路径；可先读取目录：${treeUrl}。`;
    }

    return new AppError({
        code: 'not_found',
        retryable: false,
        status: 404,
        engine: 'github',
        message: `GitHub file not found: ${owner}/${repo}@${ref}/${filePath}`,
        hint
    });
}

export type TreeFetchOutcome =
    | { status: 'ok'; content: string }
    | { status: 'notfound' }
    | { status: 'error'; message: string };

export async function fetchGithubTree(
    owner: string,
    repo: string,
    ref: string,
    dirPath?: string
): Promise<TreeFetchOutcome> {
    const ownerEnc = encodeURIComponent(owner.trim());
    const repoEnc = encodeURIComponent(repo.trim());
    const refParam = encodeURIComponent(ref.trim());
    const apiUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/git/trees/${refParam}?recursive=1`;

    try {
        const headers: Record<string, string> = {
            'User-Agent': 'GitHub-Tree-Fetcher/1.0',
            'Accept': 'application/vnd.github.v3+json',
            ...(getOptionalString('GITHUB_TOKEN') ? { Authorization: `Bearer ${getOptionalString('GITHUB_TOKEN')}` } : {})
        };
        const response = await requestDirectFirst('GET', apiUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({ headers, timeout: 10000, forceDirect })
        }), 'GitHub git trees API');

        if (response.status === 404) {
            return { status: 'notfound' };
        }
        if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
            return { status: 'error', message: `Upstream returned HTTP ${response.status}` };
        }

        const data = response.data as {
            tree?: Array<{ path?: string; type?: string; size?: number }>;
            truncated?: boolean;
        };
        if (!Array.isArray(data.tree)) {
            return { status: 'error', message: 'Invalid tree payload from GitHub API' };
        }

        let items: Array<{ path: string; type: 'blob' | 'tree'; size?: number }> = data.tree
            .filter((item): item is { path: string; type: 'blob' | 'tree'; size?: number } =>
                typeof item?.path === 'string' && (item.type === 'blob' || item.type === 'tree')
            );

        const normalizedDirPath = dirPath ? dirPath.replace(/^\/+|\/+$/g, '') : '';
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
            return { status: 'notfound' };
        }

        const originalItemsCount = items.length;
        const treeNoisePattern = /(^|\/)(node_modules|dist|build|target|coverage|\.next|\.nuxt|out|vendor|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock)(\/|$)/i;
        const filteredNoiseCount = items.filter((item) => treeNoisePattern.test(item.path)).length;
        items = items.filter((item) => !treeNoisePattern.test(item.path));
        const totalItemsCount = items.length;
        const maxTreeItems = 150;
        const isCapped = totalItemsCount > maxTreeItems;
        const displayItems = isCapped ? items.slice(0, maxTreeItems) : items;

        const renderedTree = renderAsciiTree(displayItems);
        const header = `# Directory Tree: ${owner}/${repo} @ ${ref}${normalizedDirPath ? ` (subpath: /${normalizedDirPath})` : ''}\n\nTotal items: ${originalItemsCount}${filteredNoiseCount > 0 ? ` (filtered ${filteredNoiseCount} build/lock artifacts; showing ${totalItemsCount})` : ''}${isCapped ? ` (showing first ${maxTreeItems})` : ''}\n\n`;
        const truncationNotice = isCapped ? `\n\n... and ${totalItemsCount - maxTreeItems} more items.` : '';

        return { status: 'ok', content: `${header}\`\`\`\n${renderedTree}\n\`\`\`${truncationNotice}` };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to fetch tree for ${owner}/${repo} @ ${ref}:`, message);
        return { status: 'error', message };
    }
}
