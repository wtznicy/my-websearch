import TurndownService from 'turndown';
// @ts-expect-error turndown-plugin-gfm 无类型声明（纯 JS 小插件）
import { gfm } from 'turndown-plugin-gfm';

/**
 * HTML → Markdown 转换（turndown + GFM 插件）。
 *
 * 背景：Readability 抽取后输出纯文本会丢失代码缩进与表格结构；技术文档场景下
 * Markdown（围栏代码块 + 表格）更贴合 LLM 的理解偏好、token 效率也更高。
 * 该转换作为 fetchWebContent 的可选格式（format=markdown），默认仍为纯文本（兼容）。
 */

let service: TurndownService | null = null;

/** 取 DOM 节点的第一个**元素**子节点（跳过排版产生的空白文本节点） */
function firstElementChild(node: { firstChild: unknown; nodeType?: number }): any {
    let child = (node as any).firstChild;
    while (child) {
        if (child.nodeType === 1) {
            return child;
        }
        child = child.nextSibling;
    }
    return null;
}

/**
 * 语言标识来源（按优先级）：
 * ① code/pre 的 class（`language-x` / `lang-x` / `highlight-x` / SyntaxHighlighter `brush: js;`）
 * ② code/pre 的 `data-lang` / `lang` 属性（**属性值本身就是语言**，如 `lang="ts"`）
 * 注意 `class="hljs"` 这类无语言信息的高亮类名不应被当成语言（返回空串 → 围栏不带语言）。
 */
const CODE_LANGUAGE_PATTERN = /(?:language|lang|highlight|brush)[-:\s]+([a-z0-9+#]+)/i;
const BARE_LANGUAGE_PATTERN = /^[a-z0-9+#]+$/i;

function extractCodeLanguage(pre: any, code: any): string {
    const classValues = [code?.getAttribute?.('class'), pre?.getAttribute?.('class')];
    for (const value of classValues) {
        const match = value ? String(value).match(CODE_LANGUAGE_PATTERN) : null;
        if (match?.[1]) {
            return match[1].toLowerCase();
        }
    }

    const attributeValues = [
        code?.getAttribute?.('data-lang'),
        pre?.getAttribute?.('data-lang'),
        code?.getAttribute?.('lang'),
        pre?.getAttribute?.('lang')
    ];
    for (const value of attributeValues) {
        if (!value) {
            continue;
        }
        const trimmed = String(value).trim();
        if (BARE_LANGUAGE_PATTERN.test(trimmed)) {
            return trimmed.toLowerCase();
        }
        const match = trimmed.match(CODE_LANGUAGE_PATTERN);
        if (match?.[1]) {
            return match[1].toLowerCase();
        }
    }

    return '';
}

/** 代码内容含反引号围栏时用更长的围栏，避免 Markdown 结构被内容破坏 */
function buildFence(code: string): string {
    const runs = code.match(/`+/g) || [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
}

/** 元素或其祖先（最多 2 层）是否带 `language-x` 类——VitePress/Shiki 把语言类放在外层容器上 */
function hasLanguageClass(element: any): boolean {
    const className = element?.getAttribute?.('class');
    return !!className && /(?:^|\s)language-[a-z0-9+#]+/i.test(String(className));
}

function languageFromAncestors(node: any): string {
    let current = node?.parentNode;
    for (let depth = 0; current && depth < 2; depth += 1) {
        if (hasLanguageClass(current)) {
            const match = String(current.getAttribute('class')).match(CODE_LANGUAGE_PATTERN);
            if (match?.[1]) {
                return match[1].toLowerCase();
            }
        }
        current = current.parentNode;
    }
    return '';
}

function getService(): TurndownService {
    if (service) {
        return service;
    }

    const instance = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '*'
    });

    instance.use(gfm);

    // 围栏代码块：保留语言标识，并兼容真实页面里多种 <pre> 结构。
    // 旧判据 `node.firstChild?.nodeName === 'CODE'` 在首子节点是换行空白文本时直接失效——
    // 而 `<pre>\n  <code class="language-x">` 正是格式化后 HTML 的常态（实测退化成行内代码）。
    instance.addRule('fencedCodeWithLanguage', {
        filter: (node) => node.nodeName === 'PRE',
        replacement: (_content, node) => {
            const pre = node as any;
            const child = firstElementChild(pre);
            const codeNode = child && child.nodeName === 'CODE' ? child : null;
            const language = extractCodeLanguage(pre, codeNode ?? pre) || languageFromAncestors(pre);
            const raw = String((codeNode ?? pre).textContent ?? '');
            const code = raw.replace(/^\n+/, '').replace(/\n+$/, '');
            const fence = buildFence(code);
            return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
        }
    });

    // VitePress/Shiki 结构：`<div class="language-x"><span class="lang">x</span><pre><code>…`
    // 语言标签是给读者看的可见元素；不抑制它就会漏成正文里孤立的一行（报告 B1 的现象之一）
    instance.addRule('codeLanguageLabel', {
        filter: (node) => node.nodeName === 'SPAN'
            && /(?:^|\s)lang(?:\s|$)/.test(node.getAttribute?.('class') || '')
            && (hasLanguageClass(node.parentNode) || hasLanguageClass(node.parentNode?.parentNode)),
        replacement: () => ''
    });

    // VitePress 代码组的 Tabs 标签（`<label>npm</label><label>pnpm</label>…`）：纯 UI 元素，
    // 不抑制会连成一串噪声文本（实测 `npmpnpmyarnbun`，同一页面出现多次）
    instance.addRule('codeGroupTabLabel', {
        filter: (node) => node.nodeName === 'LABEL'
            && /(?:^|\s)tabs(?:\s|$)/.test((node.parentNode as any)?.getAttribute?.('class') || ''),
        replacement: () => ''
    });

    service = instance;
    return instance;
}

/** 把 HTML 片段/文档转换为 Markdown（保留围栏代码块语言与 GFM 表格） */
export function htmlToMarkdown(html: string): string {
    if (!html || !html.trim()) {
        return '';
    }
    return getService().turndown(html).trim();
}
