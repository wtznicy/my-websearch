/**
 * GitHub/Gitee 内容抓取的时间预算与 CDN 失败转移。
 *
 * 曾经的实现：每个源固定 10~15s、7 个 README 候选 × 3 个 ref、jsDelivr 网络错误再重试一次，
 * 最坏可叠到 90~180s。这里把「总预算 + 单次上限 + host 熔断」集中管理，
 * 任何组合都不应突破内容预算。
 */

export interface ContentBudget {
    /** 绝对截止时间（Date.now() 基准） */
    deadline: number;
    /** 本次调用内已失败的 host，不再重试 */
    deadHosts: Set<string>;
    /** 最近成功的 host，后续请求优先复用 */
    preferredHost?: string;
}

export const JSDELIVR_HOSTS = [
    'cdn.jsdelivr.net',
    'fastly.jsdelivr.net',
    'gcore.jsdelivr.net'
] as const;

export const DEFAULT_CONTENT_BUDGET_MS = 12000;
/** CDN-first 时更激进：快速失败换候选 */
export const CDN_FIRST_BUDGET_MS = 6000;
/** 单次尝试上限（4.5s），配合总预算使用 */
export const ATTEMPT_TIMEOUT_MS = 4500;
/** 剩余预算低于此值就不再发起新请求 */
export const MIN_REMAINING_MS = 500;

/**
 * CDN-first 开关。新名字覆盖 README + blob；旧名 GITHUB_README_CDN_FIRST 保留为别名。
 */
export function isGithubContentCdnFirst(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.GITHUB_CONTENT_CDN_FIRST === 'true' || env.GITHUB_README_CDN_FIRST === 'true';
}

export function contentBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = Number(env.GITHUB_CONTENT_BUDGET_MS);
    if (Number.isFinite(raw) && raw >= 1000) {
        return Math.floor(raw);
    }
    return isGithubContentCdnFirst(env) ? CDN_FIRST_BUDGET_MS : DEFAULT_CONTENT_BUDGET_MS;
}

export function createContentBudget(env: NodeJS.ProcessEnv = process.env): ContentBudget {
    return { deadline: Date.now() + contentBudgetMs(env), deadHosts: new Set() };
}

export function remainingMs(budget: ContentBudget): number {
    return budget.deadline - Date.now();
}

export function attemptTimeoutMs(budget: ContentBudget, cap = ATTEMPT_TIMEOUT_MS): number {
    return Math.max(1, Math.min(cap, remainingMs(budget)));
}

export function isBudgetExhausted(budget: ContentBudget): boolean {
    return remainingMs(budget) < MIN_REMAINING_MS;
}

/** jsDelivr 的 URL 路径部分（host 无关）：/owner/repo@ref/file */
export function buildJsdelivrPath(owner: string, repo: string, ref: string, filePath: string): string {
    return `/${owner}/${repo}${ref}/${filePath}`;
}

export function buildJsdelivrUrl(host: string, owner: string, repo: string, ref: string, filePath: string): string {
    return `https://${host}/gh${buildJsdelivrPath(owner, repo, ref, filePath)}`;
}

/** 预算耗尽时统一抛这个，调用方转成可读的 AppError */
export class ContentBudgetExhaustedError extends Error {
    constructor() {
        super('GitHub/Gitee content budget exhausted before any source returned content');
        this.name = 'ContentBudgetExhaustedError';
    }
}

export interface ChangedFileLike {
    filename?: string;
    additions?: number | string;
    deletions?: number | string;
    status?: string | null;
}

export const MAX_LISTED_CHANGED_FILES = 30;

/**
 * PR 变更文件列表级截断：只列前 30 个，结尾给「… and N more」。
 * 直接用全局字符上限截断会把列表砍在半行，既不干净也丢总数信息。
 */
export function formatChangedFilesSection(files: ChangedFileLike[], totalCount: number): string[] {
    if (files.length === 0) {
        return [];
    }
    const total = Math.max(totalCount, files.length);
    const shown = files.slice(0, MAX_LISTED_CHANGED_FILES);
    const lines = ['', `## Changed Files (${shown.length} of ${total})`];
    for (const file of shown) {
        const status = file.status ? `, status: ${file.status}` : '';
        lines.push(`- \`${file.filename ?? 'unknown'}\` (+${file.additions ?? 0}, -${file.deletions ?? 0}${status})`);
    }
    if (total > shown.length) {
        lines.push(`- … and ${total - shown.length} more (list limited to ${MAX_LISTED_CHANGED_FILES} files)`);
    }
    return lines;
}
