import { transformMarkdownLinks } from './markdownLinks.js';

/**
 * 控制正文里的行内链接以什么形态进入输出。
 *
 * 动机（真机实测）：链接在长文档里只占 ~5% 字符，但在**索引/列表页**能占到
 * 46%（awesome-list 实测 46.7% 的字符是 URL）。对喂嵌入模型的场景，
 * URL 既是 token 噪声、也是语义噪声。
 */

export type LinkRetentionMode = 'all' | 'none' | 'text';

export type LinkRetentionResult = {
    content: string;
    /** 被改写的链接数量 */
    links: number;
};

export function isLinkRetentionMode(value: unknown): value is LinkRetentionMode {
    return value === 'all' || value === 'none' || value === 'text';
}

/**
 * - `all`（默认）：原样保留 `[label](url)`
 * - `text`：只保留锚文本，丢掉 URL（省钱的主档位）
 * - `none`：整个链接结构连同文本一起移除（用于剥掉纯导航/页脚）
 *
 * 图片与围栏代码块不受影响：图片有自己的字段语义，代码块里的链接是示例内容。
 */
export function applyLinkRetention(markdown: string, mode: LinkRetentionMode): LinkRetentionResult {
    if (mode === 'all') {
        return { content: markdown, links: 0 };
    }

    let links = 0;
    const content = transformMarkdownLinks(markdown, (link, raw) => {
        if (link.isImage) {
            return raw;
        }
        links += 1;
        return mode === 'text' ? link.label : '';
    });

    return { content, links };
}
