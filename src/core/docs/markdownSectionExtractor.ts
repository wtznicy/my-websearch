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

    // 如果文档没有明显的标题结构（少于 2 个标题，例如 pkg.go.dev 正文退化为单段），
    // 退化为基于段落与关键词密度的聚焦抽取（Query-Centered Excerpt Window），避免直接原样输出 30KB 巨型文本
    if (headings.length < 2) {
        // Javadoc 类/接口文档已由提供方精准定位到具体类页，不应触发无标题窗口截断破坏类结构完整性
        if (isJavadocClassDocument(trimmed)) {
            return { content: trimmed, isFocused: false };
        }
        return extractWindowByQueryTokens(trimmed, query, queryTokens, maxChars);
    }

    // 1. 动态确定切分标题集（包含所有 H2 顶级章节，以及所有 H3 具体 API 符号/小节）
    // 无论是 pkg.go.dev（6+ 个 H2、几十个 H3 函数/类型）还是 docs.rs（宏/函数/结构体 H3）：
    // 允许以 H2 或 H3 为独立切分块，更深层的 H4/H5 作为代码块或参数细节归属于父小节
    const sectionHeadings: MarkdownHeading[] = [];
    for (const h of headings) {
        if (h.level === 2 || h.level === 3) {
            sectionHeadings.push(h);
        }
    }

    const activeHeadings = sectionHeadings.length >= 2
        ? sectionHeadings
        : headings.filter((h) => h.level > 1).length >= 2
            ? headings.filter((h) => h.level > 1)
            : headings;

    // 拆分 Preamble（首个切分标题之前的所有内容，通常含 H1、简介、安装与快速上手）
    const preambleEndLine = activeHeadings[0]!.lineIndex;
    const preambleLines = lines.slice(0, preambleEndLine);
    const preambleText = preambleLines.join('\n').trim();

    // 2. 按结构化标题划分候选章节块
    const sectionBlocks: MarkdownSectionBlock[] = [];

    for (let i = 0; i < activeHeadings.length; i++) {
        const currentHeading = activeHeadings[i]!;
        const nextHeading = activeHeadings[i + 1];
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

    // 3. 寻找得分最高的章节，设置相对阈值过滤弱相关的噪音章节
    const sorted = [...sectionBlocks].sort((a, b) => b.score - a.score);
    const highestScore = sorted[0]?.score ?? 0;
    if (highestScore <= 0) {
        return { content: trimmed, isFocused: false };
    }

    // 相对阈值：至少达到最高分的 30%，过滤弱相关的噪音章节
    const scoreThreshold = Math.max(1, Math.floor(highestScore * 0.3));
    const bestMatches = sorted.filter((s) => s.score >= scoreThreshold);

    if (bestMatches.length === 0) {
        return { content: trimmed, isFocused: false };
    }

    // 4. 组装结果：Preamble + 选中的完整章节 + 目录提示
    // 若前导 Preamble 较长（> 500 字符，例如 docs.rs/pkg.go.dev 整页的 crate/pkg tour），截取前导概要，优先呈现核心章节
    let displayPreamble = preambleText;
    if (preambleText.length > 500) {
        const cut = preambleText.lastIndexOf('\n\n', 450);
        displayPreamble = (cut > 150 ? preambleText.slice(0, cut) : preambleText.slice(0, 450))
            + '\n\n*(... Overview truncated, focused section below ...)*';
    }

    const selectedBlocks: MarkdownSectionBlock[] = [];
    let currentLength = displayPreamble.length;
    const maxSections = 4;

    for (const block of bestMatches) {
        if (selectedBlocks.length >= maxSections) {
            break;
        }
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
    const otherHeadings = activeHeadings.filter((h) => !matchedTitles.includes(h.title)).map((h) => h.title);
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

/**
 * 识别文档是否为 Javadoc 导出的类/接口文档结构。
 * Javadoc 类页面通常以纯结构化块渲染，标题少于 2 个，但本身就是精准的单类页面，
 * 绝不能被无标题段落窗口截断破坏类签名和方法概览。
 */
export function isJavadocClassDocument(markdown: string): boolean {
    return /All Implemented Interfaces|Method Summary|Field Summary|Constructor Summary|Nested Class Summary|All Superinterfaces/i.test(markdown)
        || /<div class="header">|<div class="contentContainer">|<main role="main">[\s\S]*?(?:Class|Interface)\s+[A-Z]/i.test(markdown);
}

/**
 * 安全构建函数/类型/变量声明标识符匹配正则，
 * 严格转义特殊字符（如 map(、a[b、* 等），防止 new RegExp 崩溃。
 */
function buildIdentifierPattern(token: string): RegExp | null {
    if (!token) return null;
    const safe = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const startsWithWord = /^\w/.test(token);
    const endsWithWord = /\w$/.test(token);
    const prefix = startsWithWord ? '\\b' : '';
    const suffix = endsWithWord ? '\\b' : '';
    try {
        return new RegExp(`(?:func|type|var|const|def|class|interface|fn)\\s+[^\\n]*${prefix}${safe}${suffix}`, 'i');
    } catch {
        return null;
    }
}

/**
 * 当文档缺乏 Markdown 标题树时（例如 pkg.go.dev 页面转换为 Markdown 后仅含 1 个顶层标题），
 * 基于段落块与关键词密度提取最相关的上下文窗口（Query-Centered Excerpt Window），
 * 确保即使无标准 Markdown 标题，也能从 30KB 巨型文档中精准聚焦出 ~2-3KB 的核心小节。
 */
export function extractWindowByQueryTokens(
    markdown: string,
    query: string,
    queryTokens: string[],
    maxChars = 24000
): ExtractedSectionResult {
    const trimmed = markdown.trim();
    if (!query || !query.trim() || trimmed.length <= 8000 || queryTokens.length === 0) {
        return { content: trimmed, isFocused: false };
    }

    const targetExcerptBudget = Math.min(maxChars, 4000);

    const blocks = trimmed.split(/\n{2,}/);
    if (blocks.length <= 2) {
        return extractCharacterWindow(trimmed, query, queryTokens, targetExcerptBudget);
    }

    // 1. 对各个段落块进行评分
    const scoredBlocks: Array<{ index: number; text: string; score: number }> = [];
    for (let i = 0; i < blocks.length; i++) {
        const text = blocks[i]!.trim();
        if (!text) continue;
        const lowerText = text.toLowerCase();
        let score = 0;

        for (const token of queryTokens) {
            if (!token) continue;
            const identPattern = buildIdentifierPattern(token);
            if (identPattern && identPattern.test(text)) {
                score += 80;
            } else if (lowerText.includes(token.toLowerCase())) {
                const occurrences = lowerText.split(token.toLowerCase()).length - 1;
                score += 30 + Math.min(occurrences * 5, 20);
            }
        }

        // 代码块加成
        if (score > 0 && text.includes('```')) {
            score += 20;
        }

        scoredBlocks.push({ index: i, text, score });
    }

    const matched = scoredBlocks.filter((b) => b.score > 0).sort((a, b) => b.score - a.score);
    if (matched.length === 0) {
        return { content: trimmed, isFocused: false };
    }

    const best = matched[0]!;
    const bestIndex = best.index;

    // 如果最高得分块本身就超过了预算（例如整个页面只有 1 个超长块，或者段落本身就有 19KB），
    // 必须对该块做二次窗口抽取，否则当前块直接输出 20KB 导致预算彻底失效
    if (best.text.length > targetExcerptBudget) {
        return extractCharacterWindow(best.text, query, queryTokens, targetExcerptBudget);
    }

    // 2. 以最高得分段落为中心，向前后扩展上下文（保留前置签名与后续示例/说明）
    // 目标聚焦窗口约为 2000 - 4000 字符
    const selectedIndices = new Set<number>([bestIndex]);
    let currentLength = best.text.length;

    // 向前扩展 1-2 块（捕获函数签名或前置说明）
    for (let step = 1; step <= 2; step++) {
        const prevIdx = bestIndex - step;
        if (prevIdx > 0) {
            const prevBlock = blocks[prevIdx]!;
            if (currentLength + prevBlock.length <= targetExcerptBudget) {
                selectedIndices.add(prevIdx);
                currentLength += prevBlock.length;
            } else {
                break;
            }
        }
    }

    // 向后扩展 1-3 块（捕获后续用法示例或参数解释）
    for (let step = 1; step <= 3; step++) {
        const nextIdx = bestIndex + step;
        if (nextIdx < blocks.length) {
            const nextBlock = blocks[nextIdx]!;
            if (currentLength + nextBlock.length <= targetExcerptBudget) {
                selectedIndices.add(nextIdx);
                currentLength += nextBlock.length;
            } else {
                break;
            }
        }
    }

    // 若还有预算，且存在其他高分匹配段落（如相关性 >= 最高分 60% 的紧密相关方法），也按需纳入
    for (const other of matched.slice(1)) {
        if (other.score >= best.score * 0.6 && !selectedIndices.has(other.index)) {
            if (currentLength + other.text.length <= targetExcerptBudget) {
                selectedIndices.add(other.index);
                currentLength += other.text.length;
            }
        }
    }

    const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
    const minSelected = sortedIndices[0]!;
    const maxSelected = sortedIndices[sortedIndices.length - 1]!;

    // 3. 提取 Preamble（通常是第一段：库/包简介与导入）
    let displayPreamble = '';
    if (minSelected > 0 && blocks[0]) {
        const intro = blocks[0].trim();
        displayPreamble = intro.length > 500
            ? intro.slice(0, 450) + '\n\n*(... Overview truncated, focused excerpt below ...)*'
            : intro;
    }

    // 4. 组装结果
    const resultParts: string[] = [];
    if (displayPreamble) {
        resultParts.push(displayPreamble);
    }

    resultParts.push(`\n> ℹ️ **Focused Excerpt:** Retrieved focused context for "${query}" (no heading tree found in document, extracted query-dense section):\n`);

    if (minSelected > 1) {
        resultParts.push('*(... preceding sections truncated ...)*\n');
    }

    const excerptText = sortedIndices.map((idx) => blocks[idx]!.trim()).join('\n\n');
    resultParts.push(excerptText);

    if (maxSelected < blocks.length - 1) {
        resultParts.push('\n*(... following sections truncated ...)*');
    }

    return {
        content: resultParts.join('\n\n').trim(),
        isFocused: true,
        focusedSectionTitles: [`Excerpt around "${query}"`]
    };
}

function extractCharacterWindow(
    text: string,
    query: string,
    queryTokens: string[],
    maxChars: number
): ExtractedSectionResult {
    const lower = text.toLowerCase();
    let bestPos = -1;

    // 优先完整 query 匹配
    if (query && query.trim()) {
        const fullPos = lower.indexOf(query.trim().toLowerCase());
        if (fullPos !== -1) {
            bestPos = fullPos;
        }
    }

    // 其次 token 匹配
    if (bestPos === -1) {
        for (const token of queryTokens) {
            const pos = lower.indexOf(token.toLowerCase());
            if (pos !== -1) {
                bestPos = pos;
                break;
            }
        }
    }

    if (bestPos === -1) {
        return { content: text.slice(0, maxChars), isFocused: false };
    }

    const windowSize = Math.min(maxChars, 3500);
    const half = Math.floor(windowSize / 2);
    let start = Math.max(0, bestPos - half);
    let end = Math.min(text.length, start + windowSize);
    if (end === text.length) {
        start = Math.max(0, end - windowSize);
    }

    // 智能吸附到就近的换行符，避免生硬截断单词或代码行
    if (start > 0) {
        const nextLine = text.indexOf('\n', start);
        if (nextLine !== -1 && nextLine - start < 300) {
            start = nextLine + 1;
        }
    }
    if (end < text.length) {
        const prevLine = text.lastIndexOf('\n', end);
        if (prevLine !== -1 && end - prevLine < 300 && prevLine > start) {
            end = prevLine;
        }
    }

    const excerpt = text.slice(start, end).trim();
    const parts = [
        `> ℹ️ **Focused Excerpt:** Retrieved focused character window for "${query}":`,
        start > 0 ? '*(... preceding text truncated ...)*\n' : '',
        excerpt,
        end < text.length ? '\n*(... following text truncated ...)*' : ''
    ].filter(Boolean);

    return {
        content: parts.join('\n').trim(),
        isFocused: true,
        focusedSectionTitles: [`Window around "${query}"`]
    };
}
