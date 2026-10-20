/**
 * Markdown 行内链接的共享遍历器。
 *
 * `citations`（加编号引用）和 `retainLinks`（裁剪链接）都要做同一件事：
 * 在**围栏代码块之外**找到 `[label](target)`，并且跳过图片 `![alt](src)`。
 * 两套正则各写一遍必然会漂移，所以统一在这里，调用方只提供替换策略。
 */

export type MarkdownSegment = { kind: 'prose' | 'code'; text: string };

export type MarkdownLink = {
    label: string;
    target: string;
    /** `![alt](src)` —— 图片，多数策略应当原样保留 */
    isImage: boolean;
};

/** 把 markdown 切成「围栏代码块」与「正文」，代码块不参与任何链接改写。 */
export function splitByCodeFence(markdown: string): MarkdownSegment[] {
    const parts: MarkdownSegment[] = [];
    const fenceRe = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = fenceRe.exec(markdown)) !== null) {
        if (match.index > cursor) {
            parts.push({ kind: 'prose', text: markdown.slice(cursor, match.index) });
        }
        parts.push({ kind: 'code', text: match[0] });
        cursor = match.index + match[0].length;
    }
    if (cursor < markdown.length) {
        parts.push({ kind: 'prose', text: markdown.slice(cursor) });
    }
    return parts;
}

/**
 * 遍历正文中的行内链接并用 `transform` 的返回值替换。
 * 返回原样的字符串表示不修改该链接。
 */
export function transformMarkdownLinks(
    markdown: string,
    transform: (link: MarkdownLink, raw: string) => string
): string {
    if (!markdown.includes('](')) {
        return markdown;
    }

    return splitByCodeFence(markdown)
        .map((part) => {
            if (part.kind === 'code') {
                return part.text;
            }
            return part.text.replace(
                /!?\[([^\]\n]*)\]\(([^)\s]+)\)/g,
                (raw: string, label: string, target: string) => transform({
                    label,
                    target,
                    isImage: raw.startsWith('!')
                }, raw)
            );
        })
        .join('');
}
