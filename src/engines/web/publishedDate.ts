import { normalizePublishedDate } from '../../utils/dateNormalizer.js';
import { extractDateFromUrl } from '../../core/search/dateExtraction.js';

export interface ExtractPublishedDateOptions {
    url?: string;
    now?: Date;
}

/**
 * 校验提取的 ISO 年份合理性（杜绝 1970 UNIX 默认戳、异常历史时间或超前假时间）。
 */
export function isValidPublishedYear(isoDate: string, now = new Date()): boolean {
    const yearMatch = isoDate.match(/^(\d{4})-\d{2}-\d{2}$/);
    if (!yearMatch) return false;
    const year = Number(yearMatch[1]);
    const currentYear = now.getUTCFullYear();
    return year >= 1990 && year <= currentYear + 1;
}

/**
 * Schema.org 文章类高优先级实体类型。
 */
const HIGH_PRIORITY_ARTICLE_TYPES = new Set([
    'article',
    'newsarticle',
    'techarticle',
    'blogposting',
    'report',
    'scholarlyarticle',
    'socialmediaposting'
]);

const MEDIUM_PRIORITY_PAGE_TYPES = new Set([
    'webpage',
    'itempage',
    'creativework'
]);

interface CandidateEntity {
    type: string;
    priority: number;
    datePublished?: string;
    dateCreated?: string;
    uploadDate?: string;
    dateModified?: string;
}

function getEntityPriority(typeStr: unknown): number {
    if (!typeStr) return 0;
    const types = Array.isArray(typeStr) ? typeStr : [typeStr];
    for (const t of types) {
        if (typeof t !== 'string') continue;
        const normalized = t.toLowerCase().replace(/^https?:\/\/schema\.org\//i, '');
        if (HIGH_PRIORITY_ARTICLE_TYPES.has(normalized)) return 100;
        if (MEDIUM_PRIORITY_PAGE_TYPES.has(normalized)) return 50;
    }
    return 10;
}

function collectEntities(obj: unknown, list: CandidateEntity[]): void {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectEntities(item, list);
        }
        return;
    }

    const record = obj as Record<string, unknown>;
    if (record['@graph'] && Array.isArray(record['@graph'])) {
        for (const item of record['@graph']) {
            collectEntities(item, list);
        }
    }

    const priority = getEntityPriority(record['@type']);
    const datePublished = typeof record['datePublished'] === 'string' ? record['datePublished'] : undefined;
    const dateCreated = typeof record['dateCreated'] === 'string' ? record['dateCreated'] : undefined;
    const uploadDate = typeof record['uploadDate'] === 'string' ? record['uploadDate'] : undefined;
    const dateModified = typeof record['dateModified'] === 'string' ? record['dateModified'] : undefined;

    if (datePublished || dateCreated || uploadDate || dateModified) {
        list.push({
            type: String(record['@type'] ?? ''),
            priority,
            datePublished,
            dateCreated,
            uploadDate,
            dateModified
        });
    }
}

/**
 * 优先从 <script type="application/ld+json"> 解析结构化 JSON-LD。
 * 遵循 Schema.org 规范：
 * 1. 深度解析 @graph 数组与根对象；
 * 2. 区分主文章实体（Article/NewsArticle/BlogPosting 等）与全站实体（WebSite 等），优先选主文章；
 * 3. 字段优先选择首发时间 datePublished / dateCreated，再退化到 dateModified；
 * 4. 必须通过 isValidPublishedYear 校验。
 */
export function extractDateFromJsonLd(html: string, now = new Date()): string | undefined {
    if (!html) return undefined;

    const scriptRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    const candidateEntities: CandidateEntity[] = [];

    while ((match = scriptRegex.exec(html)) !== null) {
        const rawContent = match[1]?.trim();
        if (!rawContent) continue;
        try {
            const parsed = JSON.parse(rawContent);
            collectEntities(parsed, candidateEntities);
        } catch {
            // 忽略格式错误的 JSON-LD 片段
        }
    }

    if (candidateEntities.length === 0) return undefined;

    // 按优先级降序排序：高优先级 Article (100) > WebPage (50) > Other (10)
    candidateEntities.sort((a, b) => b.priority - a.priority);

    for (const entity of candidateEntities) {
        const candidateDates = [
            entity.datePublished,
            entity.dateCreated,
            entity.uploadDate,
            entity.dateModified
        ].filter(Boolean) as string[];

        for (const rawDate of candidateDates) {
            const normalized = normalizePublishedDate(rawDate, now);
            if (normalized && isValidPublishedYear(normalized, now)) {
                return normalized;
            }
        }
    }

    return undefined;
}

/**
 * 从页面 Meta 与语义标签解析结构化时间。
 */
const META_PATTERNS: RegExp[] = [
    // OpenGraph article:published_time (支持 property 与 content 两种排列顺序)
    /<meta\b[^>]+(?:property|name)=["'](?:article:published_time|og:article:published_time)["'][^>]+content=["']([^"']{6,40})["']/i,
    /<meta\b[^>]+content=["']([^"']{6,40})["'][^>]+(?:property|name)=["'](?:article:published_time|og:article:published_time)["']/i,
    // Schema.org 微数据 itemprop
    /<meta\b[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']{6,40})["']/i,
    /<meta\b[^>]+content=["']([^"']{6,40})["'][^>]+itemprop=["']datePublished["']/i,
    // 传统 publication meta
    /<meta\b[^>]+name=["'](?:pubdate|publishdate|date|dc\.date\.issued)["'][^>]+content=["']([^"']{6,40})["']/i,
    /<meta\b[^>]+content=["']([^"']{6,40})["'][^>]+name=["'](?:pubdate|publishdate|date|dc\.date\.issued)["']/i,
    // 语义化 time 标签
    /<time\b[^>]+datetime=["']([^"']{6,40})["']/i,
    // 修改时间降级兜底
    /<meta\b[^>]+(?:property|name)=["'](?:article:modified_time|og:article:modified_time)["'][^>]+content=["']([^"']{6,40})["']/i
];

export function extractDateFromMetaTags(html: string, now = new Date()): string | undefined {
    if (!html) return undefined;
    for (const pattern of META_PATTERNS) {
        const match = html.match(pattern);
        const raw = match?.[1];
        if (!raw) continue;
        const normalized = normalizePublishedDate(raw, now);
        if (normalized && isValidPublishedYear(normalized, now)) {
            return normalized;
        }
    }
    return undefined;
}

/**
 * 通用正则快速扫描（针对不完整或内联脚本碎片做最后兜底）。
 */
const FALLBACK_PATTERNS: RegExp[] = [
    /"datePublished"\s*:\s*"([^"]{6,40})"/i,
    /"dateCreated"\s*:\s*"([^"]{6,40})"/i,
    /"uploadDate"\s*:\s*"([^"]{6,40})"/i
];

/**
 * 完整页面发布日期提取管道：
 * 1. JSON-LD 语法树精准提取（识别主 Article/NewsArticle/BlogPosting，避免被推荐列表或 WebSite 污染）；
 * 2. OpenGraph 与 Meta 标签结构化提取；
 * 3. 碎片正则兜底；
 * 4. URL 路径日期回退（/2024/10/21/ 等）；
 * 5. 全程进行合理性年份校验（排除 1970 占位符与未来虚假时间）。
 */
export function extractPublishedDateFromHtml(
    html: string,
    optionsOrNow?: ExtractPublishedDateOptions | Date
): string | undefined {
    if (!html) return undefined;
    const now = optionsOrNow instanceof Date
        ? optionsOrNow
        : optionsOrNow?.now ?? new Date();
    const url = optionsOrNow instanceof Date ? undefined : optionsOrNow?.url;

    // 阶段 1：JSON-LD 语法树结构化解析
    const jsonLdDate = extractDateFromJsonLd(html, now);
    if (jsonLdDate) {
        return jsonLdDate;
    }

    // 阶段 2：Meta / OpenGraph 标签
    const metaDate = extractDateFromMetaTags(html, now);
    if (metaDate) {
        return metaDate;
    }

    // 阶段 3：原始内联文本碎片兜底
    for (const pattern of FALLBACK_PATTERNS) {
        const match = html.match(pattern);
        const raw = match?.[1];
        if (!raw) continue;
        const normalized = normalizePublishedDate(raw, now);
        if (normalized && isValidPublishedYear(normalized, now)) {
            return normalized;
        }
    }

    // 阶段 4：URL 路径日期回退
    if (url) {
        const urlDate = extractDateFromUrl(url);
        if (urlDate && isValidPublishedYear(urlDate, now)) {
            return urlDate;
        }
    }

    return undefined;
}
