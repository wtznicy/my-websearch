import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { AppError } from '../../core/errors.js';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'GitHub-Changes-Fetcher/1.0';
const MAX_PATCH_CHARS = 30_000;
const MAX_FILES = 100;
const MAX_COMMITS = 50;
const MAX_RELEASE_BODY_CHARS = 20_000;

const LOCKFILE_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock)$/i;

export interface ChangedFile {
    filename: string;
    status?: string;
    additions?: number;
    deletions?: number;
    changes?: number;
    patch?: string;
}

export interface CommitInfo {
    sha?: string;
    message?: string;
    author?: string;
    date?: string;
    url?: string;
}

export interface CommitData extends CommitInfo {
    stats?: { additions?: number; deletions?: number; total?: number };
    files?: ChangedFile[];
}

export interface CompareData {
    base?: string;
    head?: string;
    url?: string;
    commits?: CommitInfo[];
    files?: ChangedFile[];
}

export interface ReleaseData {
    tag?: string;
    name?: string;
    publishedAt?: string;
    url?: string;
    body?: string;
    assets?: Array<{ name?: string; url?: string }>;
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

function githubHeaders(): Record<string, string> {
    return {
        'User-Agent': USER_AGENT,
        'Accept': 'application/vnd.github.v3+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    };
}

async function githubGet<T>(url: string, label: string): Promise<T | null> {
    try {
        const response = await requestDirectFirst('GET', url, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                headers: githubHeaders(),
                timeout: 12000,
                forceDirect
            }),
            validateStatus: (status: number) => status >= 200 && status < 500
        }), label);

        if (response.status === 404) {
            return null;
        }
        if (response.status >= 400) {
            throw new AppError({
                code: response.status === 429 ? 'rate_limited' : 'engine_error',
                retryable: response.status === 429 || response.status >= 500,
                status: response.status,
                engine: 'github',
                message: `${label} failed with HTTP ${response.status}`
            });
        }
        return response.data as T;
    } catch (error) {
        if (error instanceof AppError) {
            throw error;
        }
        throw new AppError({
            code: 'network_error',
            retryable: true,
            engine: 'github',
            message: `${label} request failed: ${error instanceof Error ? error.message : String(error)}`
        });
    }
}

function renderFilesTable(files: ChangedFile[] | undefined): string[] {
    if (!files || files.length === 0) {
        return [];
    }
    const shown = files.slice(0, MAX_FILES);
    const lines = [
        '',
        `## Changed files (${files.length}${files.length > shown.length ? `, showing ${shown.length}` : ''})`,
        '| Status | +/- | File |',
        '| :--- | :--- | :--- |'
    ];
    for (const file of shown) {
        const status = file.status ?? '-';
        const delta = `${file.additions ?? 0} / ${file.deletions ?? 0}`;
        lines.push(`| ${status} | ${delta} | \`${file.filename}\` |`);
    }
    if (files.length > shown.length) {
        lines.push(`| … | … | ${files.length - shown.length} more files omitted |`);
    }
    return lines;
}

function renderPatches(files: ChangedFile[] | undefined): string[] {
    if (!files || files.length === 0) {
        return [];
    }
    const lines: string[] = ['', '## Patch'];
    let used = 0;
    let omittedLockfiles = 0;
    let truncated = false;

    for (const file of files.slice(0, MAX_FILES)) {
        if (LOCKFILE_RE.test(file.filename)) {
            omittedLockfiles += 1;
            continue;
        }
        if (!file.patch) {
            continue;
        }
        const block = `\n### \`${file.filename}\`\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
        if (used + block.length > MAX_PATCH_CHARS) {
            truncated = true;
            break;
        }
        lines.push(block);
        used += block.length;
    }

    if (omittedLockfiles > 0) {
        lines.push(`> Omitted ${omittedLockfiles} lockfile patch(es).`);
    }
    if (truncated) {
        lines.push(`> Patch truncated at ${MAX_PATCH_CHARS} characters; fetch the commit URL for the full diff.`);
    }
    return lines;
}

export function renderCommit(data: CommitData, fallbackSha: string): string {
    const lines: string[] = [
        `# Commit ${data.sha?.slice(0, 12) ?? fallbackSha}`,
        `- **Message**: ${(data.message ?? '').split('\n')[0]}`,
        `- **Author**: ${data.author ?? 'unknown'}`,
        `- **Date**: ${data.date ?? 'unknown'}`,
        ...(data.url ? [`- **URL**: ${data.url}`] : []),
        ...(data.stats ? [`- **Stats**: +${data.stats.additions ?? 0} / -${data.stats.deletions ?? 0} (${data.stats.total ?? 0} changes)`] : []),
        '',
        '## Full message',
        '```text',
        truncate(data.message ?? '_No message_', 4000),
        '```'
    ];
    lines.push(...renderFilesTable(data.files));
    lines.push(...renderPatches(data.files));
    return lines.join('\n');
}

export function renderCompare(data: CompareData, base: string, head: string): string {
    const lines: string[] = [
        `# Compare ${data.base ?? base}...${data.head ?? head}`,
        ...(data.url ? [`- **URL**: ${data.url}`] : []),
        `- **Commits**: ${data.commits?.length ?? 0}`
    ];
    if (data.commits && data.commits.length > 0) {
        lines.push('', '## Commits');
        for (const commit of data.commits.slice(0, MAX_COMMITS)) {
            lines.push(`- \`${commit.sha?.slice(0, 10) ?? '?'}\` ${(commit.message ?? '').split('\n')[0]} (${commit.author ?? 'unknown'})`);
        }
        if (data.commits.length > MAX_COMMITS) {
            lines.push(`- … ${data.commits.length - MAX_COMMITS} more commits omitted`);
        }
    }
    lines.push(...renderFilesTable(data.files));
    lines.push(...renderPatches(data.files));
    return lines.join('\n');
}

export function renderReleases(releases: ReleaseData[], requestedTag?: string): string {
    const lines: string[] = [`# Releases${requestedTag ? `: ${requestedTag}` : ''}`];
    for (const release of releases) {
        const tag = release.tag ?? 'unknown';
        lines.push('', `## ${release.name ? `${release.name} (${tag})` : tag}`);
        if (release.publishedAt) {
            lines.push(`- **Published**: ${release.publishedAt}`);
        }
        if (release.url) {
            lines.push(`- **URL**: ${release.url}`);
        }
        if (release.body?.trim()) {
            lines.push('', truncate(release.body.trim(), MAX_RELEASE_BODY_CHARS));
        }
        if (release.assets && release.assets.length > 0) {
            lines.push('', '**Assets**:');
            for (const asset of release.assets.slice(0, 10)) {
                lines.push(`- [${asset.name ?? 'asset'}](${asset.url ?? ''})`);
            }
        }
        lines.push('', '---');
    }
    return lines.join('\n').replace(/\n---\s*$/, '');
}

export async function fetchGithubCommit(owner: string, repo: string, sha: string): Promise<string | null> {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`;
    const data = await githubGet<{
        sha?: string;
        html_url?: string;
        commit?: { message?: string; author?: { name?: string; date?: string } };
        stats?: { additions?: number; deletions?: number; total?: number };
        files?: ChangedFile[];
    }>(url, 'GitHub commit API');
    if (!data) {
        return null;
    }
    return renderCommit({
        sha: data.sha,
        message: data.commit?.message,
        author: data.commit?.author?.name,
        date: data.commit?.author?.date,
        url: data.html_url,
        stats: data.stats,
        files: data.files
    }, sha);
}

export async function fetchGithubCompare(owner: string, repo: string, base: string, head: string): Promise<string | null> {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const data = await githubGet<{
        html_url?: string;
        base_commit?: { sha?: string };
        commits?: Array<{ sha?: string; commit?: { message?: string; author?: { name?: string; date?: string } } }>;
        files?: ChangedFile[];
    }>(url, 'GitHub compare API');
    if (!data) {
        return null;
    }
    return renderCompare({
        base,
        head,
        url: data.html_url,
        commits: data.commits?.map((commit) => ({
            sha: commit.sha,
            message: commit.commit?.message,
            author: commit.commit?.author?.name,
            date: commit.commit?.author?.date
        })),
        files: data.files
    }, base, head);
}

export async function fetchGithubReleases(owner: string, repo: string, tag?: string, limit = 10): Promise<string | null> {
    const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
    if (!tag) {
        const perPage = Math.max(1, Math.min(Math.floor(limit) || 10, 30));
        const data = await githubGet<Array<{
            tag_name?: string;
            name?: string;
            published_at?: string;
            html_url?: string;
            body?: string;
            assets?: Array<{ name?: string; browser_download_url?: string }>;
        }>>(`${base}?per_page=${perPage}`, 'GitHub releases API');
        if (!data) {
            return null;
        }
        return renderReleases(data.map((release) => ({
            tag: release.tag_name,
            name: release.name,
            publishedAt: release.published_at,
            url: release.html_url,
            body: release.body,
            assets: release.assets?.map((asset) => ({ name: asset.name, url: asset.browser_download_url }))
        })));
    }

    const url = tag === 'latest' ? `${base}/latest` : `${base}/tags/${encodeURIComponent(tag)}`;
    const data = await githubGet<{
        tag_name?: string;
        name?: string;
        published_at?: string;
        html_url?: string;
        body?: string;
        assets?: Array<{ name?: string; browser_download_url?: string }>;
    }>(url, 'GitHub release API');
    if (!data) {
        return null;
    }
    return renderReleases([{
        tag: data.tag_name,
        name: data.name,
        publishedAt: data.published_at,
        url: data.html_url,
        body: data.body,
        assets: data.assets?.map((asset) => ({ name: asset.name, url: asset.browser_download_url }))
    }], tag);
}
