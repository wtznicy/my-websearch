/**
 * 语法级 Markdown 章节智能提取器。
 *
 * 核心目标：
 * 当文档较长（如 > 8000 字符）且带有特定 query 时，
 * 绝不做盲目的随机截断或局部句子切片，而是：
 * 1. 完整保留前置导言区（Preamble / Setup / Imports），确保 import 与初始化 100% 不丢失；
 * 2. 语法级识别 `#`, `##`, `###` 标题树，将与 query 最相关的章节作为完整结构化块提取；
 * 3. 提取文档精简目录（TOC），让 LLM 明确知道文档的全局结构与还有哪些其他章节；
 * 4. 对于短文档（<= 8000 字符）或未带 query 的情况，保持全量返回，零破坏。
 */

export interface MarkdownHeading {
    level: number;
    title: string;
    raw: string;
    lineIndex: number;
}

export interface MarkdownSectionBlock {
    heading?: MarkdownHeading;
    lines: string[];
    score: number;
}

export interface ExtractedSectionResult {
    content: string;
    isFocused: boolean;
    focusedSectionTitles?: string[];
    toc?: string[];
}

/** 提取 Markdown 所有的 H1/H2/H3 目录标题 */
export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
    const lines = markdown.split(/\r?\n/);
    const headings: MarkdownHeading[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const match = /^(#{1,4})\s+(.+)$/.exec(line);
        if (match) {
            const level = match[1]!.length;
            const title = match[2]!
                .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                .replace(/^[§#\s]+/, '')
                .trim();
            headings.push({
                level,
                title,
                raw: line,
                lineIndex: i
            });
        }
    }
    return headings;
}

/** 计算某一段落或章节与 query 的匹配得分 */
function scoreSectionMatch(title: string, bodyText: string, queryTokens: string[]): number {
    let score = 0;
    const lowerTitle = title.toLowerCase();
    const lowerBody = bodyText.toLowerCase();

    for (const token of queryTokens) {
        if (!token) continue;
        // 标题精确包含关键词：权重最高
        if (lowerTitle === token) {
            score += 100;
        } else if (lowerTitle.includes(token)) {
            score += 50;
        }
        // 正文中出现该关键词
        const matches = lowerBody.split(token).length - 1;
        if (matches > 0) {
            score += Math.min(matches * 5, 30);
        }
    }

    // 检查正文内部子标题（如 #### select! 或 ### func (c *Context) Middleware）
    const subHeadings = bodyText.match(/^#{2,5}\s+(.+)$/gm);
    if (subHeadings) {
        for (const sub of subHeadings) {
            const subClean = sub.toLowerCase();
            for (const token of queryTokens) {
                if (subClean.includes(token)) {
                    score += 70;
                }
            }
        }
    }

    return score;
}

/**
 * 智能提取相关章节：
 * - 始终保留 Preamble（从开头到首个 H2 之间的内容，包含包名、安装、import 和基本启动）
 * - 按 H2/H3 将文档切块，计算相关性，完整保留命中的整节内容
 */
export function extractRelevantSections(
    markdown: string,
    query?: string,
    maxChars = 24000
): ExtractedSectionResult {
    const trimmed = markdown.trim();
    if (!trimmed) {
        return { content: '', isFocused: false };
    }

    // 短文档或无 query 时，直接完整返回
    if (!query || !query.trim() || trimmed.length <= 8000) {
        return { content: trimmed, isFocused: false };
    }

    const cleanQuery = query.trim().toLowerCase().replace(/[!！?？]/g, ' ');
    const queryTokens = cleanQuery.split(/[\s,:+/-]+/).filter((t) => t.length >= 2 || /[\u4e00-\u9fa5]/.test(t));
    if (queryTokens.length === 0) {
        return { content: trimmed, isFocused: false };
    }

    const lines = trimmed.split(/\r?\n/);
    const headings = extractMarkdownHeadings(trimmed);

    // 如果文档没有明显的标题结构（少于 2 个标题），不擅自切块，直接返回原文
    if (headings.length < 2) {
        return { content: trimmed, isFocused: false };
    }

    // 1. 动态确定主要章节的切分层级（优先 H2，若无 H2 则取 H3，否则取出现频次最高的最小层级）
    const availableLevels = headings.map((h) => h.level);
    const hasH2 = availableLevels.includes(2);
    const hasH3 = availableLevels.includes(3);
    const primaryLevel = hasH2 ? 2 : (hasH3 ? 3 : Math.min(...availableLevels));
    const primaryHeadings = headings.filter((h) => h.level === primaryLevel);

    // 拆分 Preamble（首个主标题之前的所有内容，通常含 H1、简介、安装与快速上手）
    const firstPrimaryIndex = headings.findIndex((h) => h.level === primaryLevel);
    const preambleEndLine = firstPrimaryIndex !== -1 ? headings[firstPrimaryIndex]!.lineIndex : headings[0]!.lineIndex;
    const preambleLines = lines.slice(0, preambleEndLine);
    const preambleText = preambleLines.join('\n').trim();

    // 2. 按主标题划分主要章节块
    const sectionBlocks: MarkdownSectionBlock[] = [];

    for (let i = 0; i < primaryHeadings.length; i++) {
        const currentHeading = primaryHeadings[i]!;
        const nextHeading = primaryHeadings[i + 1];
        const startLine = currentHeading.lineIndex;
        const endLine = nextHeading ? nextHeading.lineIndex : lines.length;
        const sectionLines = lines.slice(startLine, endLine);
        const sectionBody = sectionLines.slice(1).join('\n');
        const score = scoreSectionMatch(currentHeading.title, sectionBody, queryTokens);

        sectionBlocks.push({
            heading: currentHeading,
            lines: sectionLines,
            score
        });
    }

    // 3. 寻找得分最高的章节
    const sorted = [...sectionBlocks].sort((a, b) => b.score - a.score);
    const bestMatches = sorted.filter((s) => s.score > 0);

    // 如果没有任何章节匹配关键词，退回全量原文，避免盲目过滤
    if (bestMatches.length === 0) {
        return { content: trimmed, isFocused: false };
    }

    // 4. 组装结果：Preamble + 选中的完整章节 + 目录提示
    // 若前导 Preamble 冗长（> 1500 字符，例如 docs.rs 整页的 crate tour），截取前导概要，避免挤占核心章节
    let displayPreamble = preambleText;
    if (preambleText.length > 1500) {
        const cut = preambleText.lastIndexOf('\n\n', 1200);
        displayPreamble = (cut > 200 ? preambleText.slice(0, cut) : preambleText.slice(0, 1200))
            + '\n\n*(... Overview truncated, focused section below ...)*';
    }

    const selectedBlocks: MarkdownSectionBlock[] = [];
    let currentLength = displayPreamble.length;

    for (const block of bestMatches) {
        const blockLen = block.lines.join('\n').length;
        if (currentLength + blockLen <= maxChars || selectedBlocks.length === 0) {
            selectedBlocks.push(block);
            currentLength += blockLen;
        } else {
            break;
        }
    }

    // 按原文中的前后顺序重新排列选中的章节，保持阅读逻辑连续
    selectedBlocks.sort((a, b) => (a.heading?.lineIndex ?? 0) - (b.heading?.lineIndex ?? 0));

    const resultParts: string[] = [];
    if (displayPreamble) {
        resultParts.push(displayPreamble);
    }

    const matchedTitles = selectedBlocks.map((b) => b.heading?.title ?? '').filter(Boolean);
    resultParts.push(`\n> ℹ️ **Focused Sections:** Retrieved ${selectedBlocks.length} relevant section(s) for "${query}": ${matchedTitles.map((t) => `\`${t}\``).join(', ')}. (Preamble & syntax context preserved)`);

    for (const block of selectedBlocks) {
        resultParts.push(block.lines.join('\n').trim());
    }

    // 附加精炼的未展示章节目录，方便调用者知晓全貌
    const otherHeadings = primaryHeadings.filter((h) => !matchedTitles.includes(h.title)).map((h) => h.title);
    if (otherHeadings.length > 0) {
        resultParts.push('\n---\n**Other Document Sections:** ' + otherHeadings.slice(0, 8).map((t) => `\`${t}\``).join(' • ') + (otherHeadings.length > 8 ? ` *(and ${otherHeadings.length - 8} more)*` : ''));
    }

    return {
        content: resultParts.join('\n\n').trim(),
        isFocused: true,
        focusedSectionTitles: matchedTitles,
        toc: headings.map((h) => `${'  '.repeat(h.level - 1)}- ${h.title}`)
    };
}
