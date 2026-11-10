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

/**
 * 常见中文编程概念与对应英文术语词典。
 * 用于跨语言文档检索时将中文 query（如 "select! 宏"、"中间件"）自动关联到
 * 英文官方文档（docs.rs、pkg.go.dev 等）中的标准小节标题（如 "Macros"、"middleware"）。
 */
export const CHINESE_TECH_TERM_SYNONYMS: Record<string, string[]> = {
    '宏': ['macro', 'macros'],
    '中间件': ['middleware'],
    '装饰器': ['decorator', 'decorators'],
    '注解': ['annotation', 'annotations'],
    '协程': ['coroutine', 'coroutines', 'async', 'goroutine'],
    '路由': ['router', 'route', 'routes'],
    '切片': ['slice'],
    '管道': ['pipeline', 'pipe', 'channel'],
    '结构体': ['struct'],
    '枚举': ['enum'],
    '接口': ['interface'],
    '构造器': ['constructor', 'builder', 'new'],
    '上下文': ['context', 'ctx'],
    '指针': ['pointer', 'ptr'],
    '线程': ['thread', 'threading'],
    '配置': ['config', 'configuration'],
    '异常': ['exception', 'error'],
    '泛型': ['generic', 'generics']
};

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

/** 计算某一段落或章节与 query 的匹配得分 */
function scoreSectionMatch(title: string, bodyText: string, queryTokens: string[]): number {
    let score = 0;
    const lowerTitle = title.toLowerCase();
    const lowerBody = bodyText.toLowerCase();

    // 目录/索引章节（如 ## Index / ## Table of Contents）降权，避免真正的 API 内容小节被目录链接清单顶替
    if (lowerTitle === 'index' || lowerTitle === 'table of contents' || lowerTitle === '目录' || lowerTitle === '索引') {
        score -= 80;
    }

    for (const token of queryTokens) {
        if (!token) continue;
        // 标题精确包含关键词：权重最高
        if (lowerTitle === token) {
            score += 100;
        } else if (lowerTitle.includes(token)) {
            score += 50;
        }
        // 包含正式函数/方法/类型签名且参数或签名含关键词（如 func (engine *Engine) Use(middleware ...HandlerFunc)）
        const identPattern = buildIdentifierPattern(token);
        if (identPattern && (identPattern.test(title) || identPattern.test(bodyText))) {
            score += 90;
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
    const rawTokens = cleanQuery.split(/[\s,:+/-]+/).filter((t) => t.length >= 2 || /[\u4e00-\u9fa5]/.test(t));
    if (rawTokens.length === 0) {
        return { content: trimmed, isFocused: false };
    }

    const queryTokens = [...rawTokens];
    for (const [zhTerm, enSynonyms] of Object.entries(CHINESE_TECH_TERM_SYNONYMS)) {
        if (query.includes(zhTerm)) {
            for (const syn of enSynonyms) {
                if (!queryTokens.includes(syn)) {
                    queryTokens.push(syn);
                }
            }
        }
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

    // 1. 动态确定切分标题集（包含所有 H2 顶级章节、H3 具体 API 符号/小节，以及 API 声明型 H4 符号如 Go 方法/函数）
    // 无论是 pkg.go.dev（6+ 个 H2、几十个 H3 函数/类型、大量 H4 具体方法）还是 docs.rs（宏/函数/结构体 H3）：
    // 允许以 H2/H3 以及声明型 H4 为独立切分块，更深层的代码块或参数细节归属于当前符号
    const sectionHeadings: MarkdownHeading[] = [];
    for (const h of headings) {
        if (
            h.level === 2 ||
            h.level === 3 ||
            (h.level === 4 && /(?:func|type|var|const|def|class|interface|fn|macro|struct|enum)\b/i.test(h.title))
        ) {
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

    // 对于缺乏标准标题结构的长文档（如 pkg.go.dev 或扁平化的 docs.rs 页面），
    // 直接基于全篇候选位置评分（findBestOccurrencePosition）提取核心上下文窗口。
    // 避免因为不可靠的 \n{2,} 切块将相关函数与目录索引捆绑，或因段落大小碰巧 <= 4000 而原样输出冗余前置内容。
    return extractCharacterWindow(trimmed, query, queryTokens, targetExcerptBudget);
}

/**
 * 在无标题文档或超长块中智能选取最具信息量、最相关的 query 命中位置。
 * 核心优化：
 * 1. 彻底跳过/惩罚目录/索引链接行（如 pkg.go.dev 的 - [func ...](#...)），避免落入无用的 TOC 链接区；
 * 2. 优先挑选包含真实函数/类型声明、代码块及说明性正文的区域；
 * 3. 综合评估上下文窗口内的关键词密度与正文行比例。
 */
function findBestOccurrencePosition(
    text: string,
    query: string,
    queryTokens: string[]
): number {
    const lower = text.toLowerCase();
    const candidatePositions = new Set<number>();

    const cleanTerms = [
        query?.trim().toLowerCase(),
        ...queryTokens.map((t) => t.trim().toLowerCase())
    ].filter((t): t is string => Boolean(t) && t.length >= 2);

    for (const term of cleanTerms) {
        let idx = 0;
        while (idx < lower.length) {
            const pos = lower.indexOf(term, idx);
            if (pos === -1) break;
            candidatePositions.add(pos);
            idx = pos + Math.max(1, term.length);
        }
    }

    if (candidatePositions.size === 0) {
        return -1;
    }

    let bestPos = -1;
    let bestScore = -Infinity;

    for (const pos of candidatePositions) {
        let score = 0;

        // 1. 获取所在单行
        const lineStart = text.lastIndexOf('\n', pos) + 1;
        const nextNewline = text.indexOf('\n', pos);
        const lineEnd = nextNewline === -1 ? text.length : nextNewline;
        const line = text.slice(lineStart, lineEnd).trim();

        // 目录/链接行识别：- [func ...](#...) 或包含页面内锚点链接
        const isTocLink = /^\s*[-*]\s+\[/.test(line) && /\]\(#[^)]+\)/.test(line);
        if (isTocLink) {
            score -= 150;
        } else {
            score += 30;
            // 真实函数声明（func Name( 或 func (receiver) Name(）
            if (/^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z0-9_]+\s*\(/i.test(line)) {
                score += 160;
            } else if (/(?:func|type|var|const|def|class|interface|fn)\s+/i.test(line)) {
                score += 80;
            }
            // 宏定义或声明
            if (/macro_rules!|#\[macro_export\]/i.test(line) || /^\s*[a-z0-9_]+!/i.test(line) || /macros§/i.test(line)) {
                score += 150;
            }
            // 标题行加成
            if (/^#{1,5}\s+/.test(line)) {
                score += 60;
            }
        }

        // 2. 检查局部上下文窗口（前后各 800-1200 字符）
        const winStart = Math.max(0, pos - 800);
        const winEnd = Math.min(text.length, pos + 1200);
        const winText = text.slice(winStart, winEnd);

        // 代码块加成（说明是具体实现、示例或语法定义）
        if (winText.includes('```')) {
            score += 50;
        }

        // 说明性正文段落（存在非目录、非签名的常规句子）
        const winLines = winText.split('\n').map((l) => l.trim()).filter(Boolean);
        const proseLines = winLines.filter((l) => !/^\s*[-*]\s+\[/.test(l) && !/^```/.test(l) && l.length > 25);
        if (proseLines.length > 0) {
            score += 40;
        }

        // 目录列表密集惩罚（如果局部窗口大部分是目录链接）
        const tocLines = winLines.filter((l) => /^\s*[-*]\s+\[.*\]\(#/.test(l));
        if (tocLines.length >= 3) {
            score -= Math.min(tocLines.length * 15, 90);
        }

        // 完整 query 精确匹配加成（且非链接行）
        if (query && line.toLowerCase().includes(query.trim().toLowerCase()) && !isTocLink) {
            score += 60;
        }

        if (score > bestScore) {
            bestScore = score;
            bestPos = pos;
        }
    }

    return bestPos;
}

function extractCharacterWindow(
    text: string,
    query: string,
    queryTokens: string[],
    maxChars: number
): ExtractedSectionResult {
    let bestPos = findBestOccurrencePosition(text, query, queryTokens);

    if (bestPos === -1) {
        // 尝试去除标点符号后重试（例如 "map(" -> "map", "select!" -> "select"）
        const strippedQuery = query.replace(/[()[\]{}*+?^$|\\!！?？:;'"`,.<>]/g, ' ').trim();
        if (strippedQuery && strippedQuery !== query.trim()) {
            const strippedTokens = strippedQuery.split(/\s+/).filter((t) => t.length >= 2);
            bestPos = findBestOccurrencePosition(text, strippedQuery, strippedTokens);
        }
    }

    if (bestPos === -1) {
        // 若文档完全不含该关键词，提取文档头部概览区（最多 3000 字符），加上前缀提示控制在 3500 字符以内，严禁直接输出 30KB 原文
        const previewSize = Math.min(maxChars, 3000);
        const excerpt = text.slice(0, previewSize).trim();
        return {
            content: `> ℹ️ **Document Overview:** No exact matches found for "${query}". Displaying top documentation overview:\n\n${excerpt}\n\n*(... remaining content truncated ...)*`,
            isFocused: false
        };
    }

    const windowSize = Math.min(maxChars, 2800);
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

    // 提取简短 Preamble（包名、导言），如果距离很远，在上方保留导言
    let displayPreamble = '';
    if (start > 1500) {
        const firstNewline = text.indexOf('\n\n');
        if (firstNewline !== -1 && firstNewline < 500) {
            const intro = text.slice(0, firstNewline).trim();
            if (intro.length > 20 && intro.length <= 400) {
                displayPreamble = `${intro}\n\n*(... Overview truncated, focused excerpt below ...)*\n\n`;
            }
        }
    }

    const excerpt = text.slice(start, end).trim();
    const parts = [
        displayPreamble,
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
