import { normalizePublishedDate } from '../../utils/dateNormalizer.js';

/**
 * 发布日期抽取（纯本地，零网络请求）。
 *
 * 背景：15 个引擎里只有少数会在结果里带日期，`timeRange` 过滤长期形同虚设。
 * 但**绝不能**为了拿日期对每条结果发一次网页请求——10 条结果 × 1s 会把 2s 的搜索拖到 12s。
 * 所以这里只从结果自带的 url / title / description 里找线索。
 *
 * 覆盖率预期：新闻/博客类站点能到 50-60%，文档/问答/商品页天然没有日期，不要指望 100%。
 */

const MIN_YEAR = 2000;
const MAX_YEAR = 2035;

function isValidYmd(year: number, month: number, day: number): boolean {
    if (year < MIN_YEAR || year > MAX_YEAR) return false;
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toIso(year: number, month: number, day: number): string | undefined {
    if (!isValidYmd(year, month, day)) return undefined;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 从 URL 路径里抽日期。只接受**带分隔符且前后有边界**的 y/m/d 或 8 位 yyyymmdd。
 * 反例（必须拒绝）：`/item/2000/10/`（月精度）、`/v2.10.21`、`/2024/10/211`（长度越界）。
 */
export function extractDateFromUrl(rawUrl: string): string | undefined {
    let pathname: string;
    try {
        pathname = new URL(rawUrl).pathname;
    } catch {
        return undefined;
    }

    // /2024/10/21 或 /2024-10-21（要求日期段后面是分隔符或结尾）
    const separated = pathname.match(/(?:^|\/)(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?=\/|$)/);
    if (separated) {
        return toIso(Number(separated[1]), Number(separated[2]), Number(separated[3]));
    }

    // /20241021 或 /2024-10-21-article 这类 8 位连写
    const compact = pathname.match(/(?:^|\/|\D)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?=\/|$|\D)/);
    if (compact) {
        return toIso(Number(compact[1]), Number(compact[2]), Number(compact[3]));
    }

    return undefined;
}

/** 从标题/摘要里抽日期：优先绝对日期，再交给已有的相对时间解析器（3天前 / yesterday 等）。 */
export function extractDateFromText(text: string | undefined, now = new Date()): string | undefined {
    if (!text) return undefined;
    const trimmed = text.trim();
    if (!trimmed) return undefined;

    const absolute = trimmed.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
    if (absolute) {
        const iso = toIso(Number(absolute[1]), Number(absolute[2]), Number(absolute[3]));
        if (iso) return iso;
    }

    // 相对时间（含英文 "hours ago"）交给既有实现，避免重复维护一套规则
    return normalizePublishedDate(trimmed, now);
}

export interface DateExtractionInput {
    url?: string;
    title?: string;
    description?: string;
    /** 引擎直接给出的日期字段（优先级最高） */
    rawDate?: string;
}

/**
 * 按可靠性排序：引擎日期字段 → 标题 → 摘要 → URL。
 * URL 放最后：它是所有来源里误判概率最高的（商品 ID、版本号）。
 */
export function derivePublishedAt(input: DateExtractionInput, now = new Date()): string | undefined {
    return normalizePublishedDate(input.rawDate, now)
        ?? extractDateFromText(input.title, now)
        ?? extractDateFromText(input.description, now)
        ?? (input.url ? extractDateFromUrl(input.url) : undefined);
}
