import { AppError } from '../core/errors.js';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

/**
 * 把 HTML 收窄到某个 CSS 选择器命中的子树。
 *
 * 用途：自动正文提取（Readability / 容器打分）在长尾站点上会拿错容器——
 * 侧栏目录比正文长、issue 页抓到评论区。此时调用方明确知道正文在哪，
 * 可以指定 `selector` 直接收窄，后续 markdown 转换照常走。
 *
 * 关键行为：**选择器没命中就报错，绝不静默回退全页**。
 * 静默回退会让调用方以为拿到了精准内容，然后在错误前提上继续推理，
 * 比直接失败更难排查。
 */

/**
 * 选择器失败时给出的候选。只覆盖最常见的正文容器命名，
 * 目的是让错误信息直接可行动，而不是让调用方去猜。
 */
const CANDIDATE_SELECTORS = [
    'main',
    'article',
    '[role="main"]',
    '#content',
    '#main',
    '.content',
    '.markdown-body',
    '.article-content',
    '.post-content'
];

export type HtmlScopeResult = {
    /** 命中节点的 outerHTML（多个命中按文档顺序拼接） */
    html: string;
    /** 选择器命中的节点总数 */
    matched: number;
};

/** 单次收窄最多拼接多少个节点，避免一个通配选择器把内存打爆 */
const MAX_SCOPED_NODES = 500;

export function scopeHtmlToSelector(html: string, selector: string): HtmlScopeResult {
    let $: cheerio.CheerioAPI;
    try {
        $ = cheerio.load(html);
    } catch (error) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: `Unable to parse the response as HTML for selector "${selector}": ${error instanceof Error ? error.message : String(error)}`
        });
    }

    let nodes: cheerio.Cheerio<AnyNode>;
    try {
        nodes = $(selector);
    } catch (error) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: `Invalid CSS selector "${selector}": ${error instanceof Error ? error.message : String(error)}`
        });
    }

    if (nodes.length === 0) {
        const candidates: string[] = [];
        for (const candidate of CANDIDATE_SELECTORS) {
            try {
                if ($(candidate).length > 0) {
                    candidates.push(candidate);
                }
            } catch {
                // 候选选择器本身不合法时直接忽略
            }
        }

        throw new AppError({
            code: 'selector_not_found',
            retryable: false,
            message: `selector "${selector}" matched no element on this page`,
            details: {
                selector,
                ...(candidates.length > 0 ? { candidates } : {})
            },
            hint: candidates.length > 0
                ? `This page has: ${candidates.join(', ')}. Use one of those, or omit selector to extract the whole page.`
                : 'Omit selector to extract the whole page, or check the selector against the page source.'
        });
    }

    // 多个命中按文档顺序拼接：`div.quote` 这类列表选择器返回全部条目才有意义，
    // 只取第一个会让「收窄」退化成「丢掉后面条目的内容」。
    const selected = nodes.slice(0, MAX_SCOPED_NODES).toArray();
    const htmlOut = selected
        .map((node) => $.html(node) ?? '')
        .filter(Boolean)
        .join('\n');

    return {
        html: htmlOut,
        matched: nodes.length
    };
}
