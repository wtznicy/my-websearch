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

interface DomElementLike {
    nodeName?: string;
    nodeType?: number;
    textContent?: string | null;
    firstChild?: DomElementLike | null;
    nextSibling?: DomElementLike | null;
    nextElementSibling?: DomElementLike | null;
    previousElementSibling?: DomElementLike | null;
    parentNode?: DomElementLike | null;
    childNodes?: ArrayLike<unknown>;
    getAttribute?(name: string): string | null | undefined;
}

/** 取 DOM 节点的第一个**元素**子节点（跳过排版产生的空白文本节点） */
function firstElementChild(node: DomElementLike): DomElementLike | null {
    let child = node.firstChild;
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

function extractCodeLanguage(pre: DomElementLike | null | undefined, code: DomElementLike | null | undefined): string {
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
function hasLanguageClass(element: DomElementLike | null | undefined): boolean {
    const className = element?.getAttribute?.('class');
    return !!className && /(?:^|\s)language-[a-z0-9+#]+/i.test(String(className));
}

/**
 * 从紧邻的语言标签取语言。两种真实形态（实测 Readability 链路）：
 * ① `<span class="lang">js</span><pre>…`（VitePress 原始结构）
 * ② `<p>js</p><pre>…`（Readability 把标签规整成了一个只含语言令牌的段落，
 *    同时把 `language-x` 外层 div 丢掉、只剩 tab 名如 options-api）
 */
function languageFromAdjacentLabel(pre: DomElementLike | null | undefined): string {
    const sibling = pre?.previousElementSibling;
    if (!sibling) {
        return '';
    }
    const name = sibling.nodeName;
    const className = sibling.getAttribute?.('class') || '';
    const text = String(sibling.textContent || '').trim().toLowerCase();
    const isLabelSpan = name === 'SPAN' && /(?:^|\s)lang(?:\s|$)/.test(className);
    if (!isLabelSpan && name !== 'P') {
        return '';
    }
    return /^[a-z0-9+#]{1,12}$/.test(text) ? text : '';
}

/** 该节点是否是"孤立的语言标签"（整段只有语言令牌且紧邻代码块）——用于抑制它，避免漏成正文 */
function isStrayLanguageLabel(node: DomElementLike | null | undefined): boolean {
    if (node?.nodeName !== 'P') {
        return false;
    }
    const text = String(node.textContent || '').trim().toLowerCase();
    return /^[a-z0-9+#]{1,12}$/.test(text) && node.nextElementSibling?.nodeName === 'PRE';
}

function languageFromAncestors(node: DomElementLike | null | undefined): string {
    let current = node?.parentNode;
    for (let depth = 0; current && depth < 2; depth += 1) {
        if (hasLanguageClass(current)) {
            const match = String(current.getAttribute?.('class') || '').match(CODE_LANGUAGE_PATTERN);
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
            const pre = node as unknown as DomElementLike;
            const child = firstElementChild(pre);
            const codeNode = child && child.nodeName === 'CODE' ? child : null;
            // 语言来源优先级：code/pre 自身属性 → 祖先容器类 → 紧邻的语言标签文本
            // （最后一条覆盖 Readability 解包 `language-x` 容器、只剩 `<span class="lang">js</span>` 的情况）
            const language = extractCodeLanguage(pre, codeNode ?? pre)
                || languageFromAncestors(pre)
                || languageFromAdjacentLabel(pre);
            const raw = String((codeNode ?? pre).textContent ?? '');
            const code = raw.replace(/^\n+/, '').replace(/\n+$/, '');
            const fence = buildFence(code);
            return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
        }
    });

    // VitePress/Shiki 结构：`<div class="language-x"><span class="lang">x</span><pre><code>…`
    // 语言标签是给读者看的可见元素；不抑制它就会漏成正文里孤立的一行。
    // 注意：Readability 会把 `language-x` 外层 div 解包，祖先类可能不存在了——
    // 因此只要"标签紧邻代码块"就抑制（否则 readability 链路下会漏成孤立语言行）。
    instance.addRule('codeLanguageLabel', {
        filter: (node) => node.nodeName === 'SPAN'
            && /(?:^|\s)lang(?:\s|$)/.test(node.getAttribute?.('class') || '')
            && (hasLanguageClass(node.parentNode as unknown as DomElementLike)
                || hasLanguageClass((node.parentNode as unknown as DomElementLike)?.parentNode)
                || (node as unknown as DomElementLike).nextElementSibling?.nodeName === 'PRE'),
        replacement: () => ''
    });

    // VitePress 代码组的 Tabs 标签（`<label>npm</label><label>pnpm</label>…`）：纯 UI 元素，
    // 不抑制会连成一串噪声文本（实测 `npmpnpmyarnbun`，同一页面出现多次）
    instance.addRule('codeGroupTabLabel', {
        filter: (node) => node.nodeName === 'LABEL'
            && /(?:^|\s)tabs(?:\s|$)/.test(((node.parentNode as unknown) as DomElementLike | null)?.getAttribute?.('class') || ''),
        replacement: () => ''
    });

    // Readability 链路下语言标签会变成"只含语言令牌的段落"（如 `<p>js</p><pre>…`）：
    // 语言已被围栏规则取用，这里把它从正文里删掉（否则漏成孤立的一行）
    instance.addRule('strayCodeLanguageLabel', {
        filter: (node) => isStrayLanguageLabel(node as unknown as DomElementLike),
        replacement: () => ''
    });

    // GFM 表格单元格：转义单元格文本内的 '|' 为 '\|'，防止内容中的竖线被误当成列分隔符破坏表格结构（测评报告 P0-2 建议 ④）
    // 注意：turndown-plugin-gfm 原生的 tableCell 未转义竖线；tableRow 在生成对齐分割线时直接调用内部 cell()，
    // 因此覆盖 tableCell 不会影响列对齐声明（:-- / :-: / --:），仅保护单元格内容本身。
    instance.addRule('tableCell', {
        filter: ['th', 'td'],
        replacement: (content, node) => {
            const parent = (node as unknown as DomElementLike).parentNode;
            const index = Array.prototype.indexOf.call(parent?.childNodes ?? [], node);
            const prefix = index === 0 ? '| ' : ' ';
            const escaped = content.replace(/(?<!\\)\|/g, '\\|');
            return `${prefix}${escaped} |`;
        }
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
