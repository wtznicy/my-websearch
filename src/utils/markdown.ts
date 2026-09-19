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

    // 保留代码块语言：标准 rule 丢弃 class，这里从 <code class="language-x"> /
    // <pre class="language-x"> 提取语言标识写入围栏
    instance.addRule('fencedCodeWithLanguage', {
        filter: (node) => node.nodeName === 'PRE' && node.firstChild?.nodeName === 'CODE',
        replacement: (_content, node) => {
            const codeNode = node.firstChild as HTMLElement;
            const className = `${node.getAttribute('class') || ''} ${codeNode.getAttribute('class') || ''}`;
            const languageMatch = className.match(/(?:language|lang|highlight)-([a-z0-9+#]+)/i);
            const language = languageMatch ? languageMatch[1].toLowerCase() : '';
            const code = codeNode.textContent || '';
            return `\n\n\`\`\`${language}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`;
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
