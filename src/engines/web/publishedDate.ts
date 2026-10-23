import { normalizePublishedDate } from '../../utils/dateNormalizer.js';

/**
 * 从页面 HTML 里抽取发布日期（纯本地，正则即可，不需要建 DOM）。
 *
 * 搜索结果层看不到日期是常态，但**抓到的页面**往往带结构化元数据：
 * JSON-LD 的 datePublished、article:published_time、<time datetime>。
 * 这层抽取只服务 fetchWebContent 的返回，不影响 search 的 timeRange（搜索阶段不抓页面）。
 */
const PATTERNS: RegExp[] = [
    // JSON-LD / 内联脚本
    /"datePublished"\s*:\s*"([^"]{6,40})"/i,
    /"dateCreated"\s*:\s*"([^"]{6,40})"/i,
    /"uploadDate"\s*:\s*"([^"]{6,40})"/i,
    // OpenGraph / 常见 meta
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']{6,40})["']/i,
    /<meta[^>]+content=["']([^"']{6,40})["'][^>]+property=["']article:published_time["']/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']{6,40})["']/i,
    /<meta[^>]+name=["'](?:pubdate|publishdate|date|DC\.date\.issued)["'][^>]+content=["']([^"']{6,40})["']/i,
    // 语义化 time 标签
    /<time[^>]+datetime=["']([^"']{6,40})["']/i
];

export function extractPublishedDateFromHtml(html: string): string | undefined {
    if (!html) return undefined;
    for (const pattern of PATTERNS) {
        const match = html.match(pattern);
        const raw = match?.[1];
        if (!raw) continue;
        const normalized = normalizePublishedDate(raw);
        if (normalized) {
            return normalized;
        }
    }
    return undefined;
}
