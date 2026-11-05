/**
 * 搜索结果重排微调规则
 * 包含：时效性平滑衰减、规范版本路径加权、标题主体焦点度软降权。
 */

export const FRESHNESS_KEYWORDS = /\b(202[4-9]|latest|recent|newest|today)\b|最新|新版|新特性|升级|版本|\bv\d+\b/i;

/** 时效性平滑微调（P2-8） */
export function computeFreshnessAdjustment(dateStr?: string, queryHasFreshness?: boolean): number {
    if (!queryHasFreshness || !dateStr) {
        return 0;
    }
    const yearMatch = dateStr.match(/\b(20\d{2})\b/);
    if (!yearMatch || !yearMatch[1]) {
        return 0;
    }
    const year = parseInt(yearMatch[1], 10);
    const currentYear = new Date().getFullYear();
    const diff = currentYear - year;

    if (diff <= 0) {
        return 0.12;
    }
    if (diff === 1) {
        return 0.06;
    }
    if (diff === 2) {
        return 0;
    }
    return Math.max(-0.20, -0.04 * (diff - 1));
}

/** 版本与规范路径偏好微调（含日期型规范路径，如 /specification/2026-07-28） */
export function computeVersionPathAdjustment(urlStr: string): number {
    try {
        const url = new URL(urlStr);
        const path = url.pathname.toLowerCase();

        // 1. 规范日期型路径（如 /specification/2026-07-28 vs /specification/2025-03-26）
        const specDateMatch = path.match(/\b(20\d{2})[-_.](\d{2})[-_.](\d{2})\b/);
        if (specDateMatch && (path.includes('spec') || path.includes('draft') || path.includes('standard') || path.includes('protocol'))) {
            const specYear = parseInt(specDateMatch[1]!, 10);
            const currentYear = new Date().getFullYear();
            const yearDiff = currentYear - specYear;
            if (yearDiff <= 0) {
                return 0.18;
            }
            if (yearDiff === 1) {
                return 0.04;
            }
            return Math.max(-0.20, -0.06 * yearDiff);
        }

        // 2. 陈旧/归档路径
        if (
            /\/(legacy|archive|archived|deprecated|obsolete|historic)(\/|$)/.test(path)
            || /\/v0\.[0-9]+(\/|$)/.test(path)
            || /\/(old|older)-version/.test(path)
        ) {
            return -0.12;
        }

        // 3. 最新/活跃/标准路径
        if (
            /\/(latest|current|stable|draft|next|main)(\/|$)/.test(path)
            || /\/v[2-9](\.[0-9]+)?(\/|$)/.test(path)
        ) {
            return 0.08;
        }

        return 0;
    } catch {
        return 0;
    }
}

/**
 * 标题焦点度微调（Title Focus Soft Penalty）
 *
 * 识别“标题前半段被其他技术主题占据，核心查询实体仅在末尾作为资讯列举/随口蹭词”的资讯聚合页面。
 * 例如：
 * - 查询："Vitest 中文文档"（核心实体：vitest）
 * - 页面标题："React 18 / Electron 18 正式发布，附带 Vue 3 与 Vitest 更新"
 *
 * 判定规则：
 * 1. 核心实体（coreTokens）在标题中出现；
 * 2. 核心实体首次出现位置位于标题后半段（relativePos > 0.40 且字符索引 > 15）；
 * 3. 标题前半段含有聚合/周刊特征（如“周刊/发布/汇总/更新/newsletter/weekly/roundup”）
 *    或含有 ≥2 个技术并列分隔符（逗号、顿号、斜杠、加号、vs）；
 * 满足时施加 -0.30 软降权（不硬性删除，避免误伤真正的综合周刊，但防止其抢占 Top 1）。
 */
export function computeTitleFocusPenalty(title: string, coreTokens: string[]): number {
    if (!title || !coreTokens || coreTokens.length === 0) {
        return 0;
    }
    const lowerTitle = title.toLowerCase();
    let minCoreIdx = -1;
    for (const token of coreTokens) {
        const idx = lowerTitle.indexOf(token.toLowerCase());
        if (idx !== -1 && (minCoreIdx === -1 || idx < minCoreIdx)) {
            minCoreIdx = idx;
        }
    }
    if (minCoreIdx === -1) {
        return 0;
    }

    const titleLength = title.length;
    const relativePos = minCoreIdx / titleLength;

    // 若核心词位于标题前 40% 或前 15 个字符内，属于主体或焦点前置，不惩罚
    if (relativePos <= 0.40 || minCoreIdx <= 15) {
        return 0;
    }

    const prefix = title.slice(0, minCoreIdx);
    const hasAggregatorTerm = /(周刊|早报|月刊|资讯|日报|动态|发布|汇总|release|newsletter|weekly|roundup)/i.test(prefix);
    const separatorCount = (prefix.match(/[,，/、+|]| vs /gi) || []).length;

    if (hasAggregatorTerm || separatorCount >= 2) {
        return -0.30;
    }

    return 0;
}
