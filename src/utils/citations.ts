/**
 * 把 Markdown 里的行内链接改写成「正文编号 + 末尾引用列表」。
 *
 * 目的：只给 LLM 一个中立的 URL 数组，它并不会引用；而正文里带 `[3]` 锚点、
 * 末尾有 `3. https://...` 的列表，是可追溯输出的最小成本做法。
 *
 * 只处理正文，不碰围栏代码块（否则会把示例代码里的链接改坏）。
 */

import { transformMarkdownLinks } from './markdownLinks.js';

export type CitationOptions = {
    /** 最多编号多少条引用；超出的链接保持原样，避免出现指向不存在条目的编号 */
    maxReferences?: number;
    /** 页面最终 URL：用于把 `/path` 这类相对链接解析成可引用的绝对地址 */
    baseUrl?: string;
};

export type CitationResult = {
    content: string;
    /** 实际分配的引用编号数量 */
    references: number;
    /** 因超出上限而未编号的链接出现次数 */
    uncited: number;
};

const DEFAULT_MAX_REFERENCES = 40;

const collapseLabel = (label: string): string => label.replace(/\s+/g, ' ').trim();

/**
 * 解析链接目标：只接受 http(s)。
 * 站内相对链接（`/login`、`../a`）在提供 baseUrl 时按页面地址补全——
 * 否则绝大多数真实页面的链接都无法被引用。
 */
const resolveTarget = (target: string, baseUrl?: string): string | null => {
    const trimmed = target.trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return null;
    }
    if (/^(mailto|tel|javascript|data):/i.test(trimmed)) {
        return null;
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    if (!baseUrl) {
        return null;
    }
    try {
        const resolved = new URL(trimmed, baseUrl);
        return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
    } catch {
        return null;
    }
};

export function addCitations(markdown: string, options: CitationOptions = {}): CitationResult {
    const maxReferences = options.maxReferences ?? DEFAULT_MAX_REFERENCES;
    if (!markdown.includes('](')) {
        return { content: markdown, references: 0, uncited: 0 };
    }

    const order: string[] = [];
    const numbers = new Map<string, number>();
    let uncited = 0;

    const rewritten = transformMarkdownLinks(markdown, (link, raw) => {
        if (link.isImage) {
            return raw;
        }

        const url = resolveTarget(link.target, options.baseUrl);
        if (!url) {
            return raw;
        }

        let number = numbers.get(url);
        if (number === undefined) {
            if (order.length >= maxReferences) {
                uncited += 1;
                return raw;
            }
            order.push(url);
            number = order.length;
            numbers.set(url, number);
        }

        const cleaned = collapseLabel(link.label);
        return !cleaned || cleaned === url
            ? `[${number}]`
            : `${cleaned} [${number}]`;
    });

    if (order.length === 0) {
        return { content: markdown, references: 0, uncited };
    }

    const references = order
        .map((url, index) => `${index + 1}. ${url}`)
        .join('\n');
    const suffix = uncited > 0
        ? `\n\n_(${uncited} further links left uncited: reference cap is ${maxReferences})_`
        : '';

    return {
        content: `${rewritten}\n\n## References\n${references}${suffix}`,
        references: order.length,
        uncited
    };
}
