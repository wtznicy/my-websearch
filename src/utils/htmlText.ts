import { normalizeText } from './text.js';

/**
 * 取「干净文本」：先把 style/script 等非内容节点从克隆里删掉，再取 text。
 *
 * 背景：cheerio 的 `.text()` 会把 `<style>` 里的 CSS 当文本节点一起返回。
 * Bing 答案卡（li.b_ans）内含 `#rscarousel strong{...}` 这类样式块，
 * 直接用 `.text()` 会把整段 CSS 带进 directAnswer。
 */
export interface CleanableSelection {
    clone(): CleanableSelection;
    find(selector: string): { remove(): unknown };
    text(): string;
}

export function textFromSelection(selection: CleanableSelection): string {
    const cloned = selection.clone();
    cloned.find('style, script, noscript, template, svg').remove();
    return normalizeText(cloned.text());
}

/**
 * 兜底清除漏网的 CSS 片段（选择器 + 声明块 / @media）。
 * 只匹配「像选择器的前缀 + 花括号块」，避免误删普通文本里的括号内容。
 */
export function stripCssFragments(text: string): string {
    return normalizeText(text
        .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ' ')
        .replace(/(?:[#.][\w-]+[^{}]*|[a-z][\w-]*(?:\s+[#.][\w-]+)?)\{[^{}]*\}/gi, ' '));
}
