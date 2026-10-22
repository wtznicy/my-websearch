/**
 * 无依赖 BM25 正文靶向（focus）实现。
 *
 * 动机：此前的 focus 是「首次 indexOf + 前后各 2500 字」的固定窗口
 * （见 pagination.ts 的 window 模式），三个硬伤：
 *   1. 只命中关键词第一次出现的位置；
 *   2. 只给一段连续窗口，窗口里大部分可能是无关内容；
 *   3. 关键词在页面里散落多处时，只能拿到其中一处。
 *
 * 这里改成：按段落切块 → 对每块算 BM25 相关性分 → 取分数最高的若干块 →
 * 按原文顺序重新拼接。纯 JS，无依赖，不需要模型。
 *
 * 中文没有空格分词，所以 tokenizer 对 CJK 连写串产出**二元组**（bigram），
 * 拉丁文按 [a-z0-9_]+ 切词。
 */

export type TextBlock = {
    text: string;
    /** 在原文中的起止偏移 */
    start: number;
    end: number;
    /** 该块所属的最近一级标题（若原文是 markdown），用于拼接时保留上下文 */
    heading?: string;
};

const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af';
const TOKEN_RE = new RegExp(`[a-z0-9_]+|[${CJK_CLASS}]+`, 'g');
const CJK_RE = new RegExp(`^[${CJK_CLASS}]+$`);

const MAX_BLOCK_CHARS = 1500;

/**
 * 切词：拉丁词原样，CJK 连写串切成二元组（单字串保留单字）。
 * 二元组比单字更能区分语义，又不需要分词词典。
 */
export function tokenize(text: string): string[] {
    const tokens: string[] = [];
    const lowered = text.toLowerCase();
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_RE.exec(lowered)) !== null) {
        const run = match[0];
        if (!CJK_RE.test(run)) {
            tokens.push(run);
            continue;
        }
        if (run.length === 1) {
            tokens.push(run);
            continue;
        }
        for (let index = 0; index + 1 < run.length; index += 1) {
            tokens.push(run.slice(index, index + 2));
        }
    }
    return tokens;
}

const looksLikeHeading = (line: string): boolean => /^\s{0,3}#{1,6}\s+\S/.test(line);

const sentenceSplit = (text: string, limit: number): Array<{ text: string; offset: number }> => {
    if (text.length <= limit) {
        return [{ text, offset: 0 }];
    }
    const parts: Array<{ text: string; offset: number }> = [];
    let cursor = 0;
    while (cursor < text.length) {
        let end = Math.min(text.length, cursor + limit);
        if (end < text.length) {
            // 尽量在句末/换行处断开，避免切断句子
            const slice = text.slice(cursor, end);
            const breakAt = Math.max(
                slice.lastIndexOf('。'),
                slice.lastIndexOf('. '),
                slice.lastIndexOf('\n'),
                slice.lastIndexOf('! '),
                slice.lastIndexOf('? ')
            );
            if (breakAt > limit * 0.5) {
                end = cursor + breakAt + 1;
            }
        }
        parts.push({ text: text.slice(cursor, end), offset: cursor });
        cursor = end;
    }
    return parts;
};

/**
 * 按空行/标题切块，并保留每块在原文中的偏移。
 *
 * 标题行会与它的正文合并成一个块（否则 `## Auth` 会变成一个没有内容的独立块，
 * 既浪费名额又丢失上下文）；超长块按句子边界再切。
 */
export function splitIntoBlocks(text: string, options: { maxBlockChars?: number } = {}): TextBlock[] {
    const maxChars = options.maxBlockChars ?? MAX_BLOCK_CHARS;
    if (!text.trim()) {
        return [];
    }

    const blocks: TextBlock[] = [];
    let buffer = '';
    let bufferStart = 0;
    let bufferEnd = 0;
    let heading: string | undefined;
    let pendingHeading: { line: string; start: number } | undefined;

    const pushBlock = (raw: string, start: number, end: number, blockHeading?: string): void => {
        const trimmed = raw.trim();
        if (!trimmed) {
            return;
        }
        // raw 可能带有挂起标题的前缀，chunk 的偏移要相对 raw 计算
        const baseOffset = raw.indexOf(trimmed);
        for (const chunk of sentenceSplit(trimmed, maxChars)) {
            const chunkText = chunk.text.trim();
            if (!chunkText) {
                continue;
            }
            const chunkStart = start + baseOffset + chunk.offset;
            blocks.push({
                text: chunkText,
                start: chunkStart,
                end: Math.min(end, chunkStart + chunkText.length),
                ...(blockHeading ? { heading: blockHeading } : {})
            });
        }
    };

    const flush = (): void => {
        const raw = buffer;
        buffer = '';
        if (!raw.trim()) {
            return;
        }

        const isHeadingOnly = raw.trim().split('\n').length === 1 && looksLikeHeading(raw);
        if (isHeadingOnly) {
            // 标题单独成段：挂起，等正文本体到达时一起产出
            pendingHeading = { line: raw.trim(), start: bufferStart };
            heading = raw.trim().replace(/^\s{0,3}#{1,6}\s+/, '');
            return;
        }

        const prefix = pendingHeading ? `${pendingHeading.line}\n\n` : '';
        const start = pendingHeading ? pendingHeading.start : bufferStart;
        pushBlock(prefix + raw, start, bufferEnd, heading);
        pendingHeading = undefined;
    };

    let offset = 0;
    for (const line of text.split('\n')) {
        const lineStart = offset;
        offset += line.length + 1;

        if (looksLikeHeading(line)) {
            flush();
            buffer = line;
            bufferStart = lineStart;
            bufferEnd = lineStart + line.length;
            heading = line.trim().replace(/^\s{0,3}#{1,6}\s+/, '');
            continue;
        }

        if (!buffer) {
            bufferStart = pendingHeading ? pendingHeading.start : lineStart;
        }
        buffer = buffer ? `${buffer}\n${line}` : line;
        bufferEnd = lineStart + line.length;

        if (!line.trim()) {
            flush();
        }
    }
    flush();

    return blocks;
}

/**
 * BM25 打分（k1=1.2, b=0.75），返回与 blocks 等长的分数数组。
 *
 * `literalTerm` 的作用：BM25 只认「token 完全相等」，而 tokenizer 会把
 * `CRITICAL_METRICBBBB` 这种紧邻文本吞成一个 token，导致字面命中反而 0 分。
 * 所以对**包含完整关键词字面串**的块加一个远大于 BM25 量级的固定加成：
 * 字面命中永远优先入选，剩余预算再按 BM25 相关性补充（关键词有多个词时，
 * 只命中部分词的块也能靠 BM25 进入结果）。
 */
export function scoreBlocks(
    blocks: readonly string[],
    queryTokens: readonly string[],
    literalTerm?: string
): number[] {
    const k1 = 1.2;
    const b = 0.75;
    const total = blocks.length;
    if (total === 0 || queryTokens.length === 0) {
        return blocks.map(() => 0);
    }

    const blockTokens = blocks.map((block) => tokenize(block));
    const lengths = blockTokens.map((tokens) => tokens.length);
    const averageLength = lengths.reduce((sum, value) => sum + value, 0) / total || 1;

    const uniqueQuery = [...new Set(queryTokens)];
    const documentFrequency = new Map<string, number>();
    for (const term of uniqueQuery) {
        let df = 0;
        for (const tokens of blockTokens) {
            if (tokens.includes(term)) {
                df += 1;
            }
        }
        documentFrequency.set(term, df);
    }

    const literalNeedle = literalTerm?.trim().toLowerCase();
    const literalBoost = 1000;

    return blockTokens.map((tokens, index) => {
        const block = blocks[index] ?? '';
        const hasLiteral = Boolean(literalNeedle && block.toLowerCase().includes(literalNeedle));

        const length = lengths[index] ?? 0;
        if (length === 0) {
            return hasLiteral ? literalBoost : 0;
        }
        const counts = new Map<string, number>();
        for (const token of tokens) {
            counts.set(token, (counts.get(token) ?? 0) + 1);
        }

        let score = 0;
        for (const term of uniqueQuery) {
            const tf = counts.get(term) ?? 0;
            if (tf === 0) {
                continue;
            }
            const df = documentFrequency.get(term) ?? 0;
            const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
            const denominator = tf + k1 * (1 - b + (b * length) / averageLength);
            score += idf * ((tf * (k1 + 1)) / denominator);
        }
        return hasLiteral ? score + literalBoost : score;
    });
}

export type FocusSelection = {
    content: string;
    /** 命中并返回的块数 */
    selectedBlocks: number;
    totalBlocks: number;
    /** 返回内容在全文中的起止偏移（用于 nextStartIndex 语义） */
    start: number;
    end: number;
    /** 得分最高的块在全文中的偏移 */
    bestOffset: number;
    /** 该块命中的关键词数量（用于判断是否真的命中） */
    matchedTerms: number;
};

/**
 * 按 BM25 选出最相关的若干块并拼接。
 *
 * 注意：**零命中时也返回结果对象**（selectedBlocks=0，totalBlocks 尽量给出），
 * 而不是 null——调用方需要把"扫过多少块、命中 0 块"这个事实暴露给用户，
 * 否则 focus 没命中会和"没传 focus"完全无法区分。
 */
export function selectFocusBlocks(
    fullText: string,
    focus: string,
    maxChars: number
): FocusSelection {
    const emptySelection = (totalBlocks: number): FocusSelection => ({
        content: '',
        selectedBlocks: 0,
        totalBlocks,
        start: 0,
        end: 0,
        bestOffset: 0,
        matchedTerms: 0
    });

    const blocks = splitIntoBlocks(fullText);
    if (blocks.length === 0) {
        return emptySelection(0);
    }

    const queryTokens = tokenize(focus);
    if (queryTokens.length === 0) {
        return emptySelection(blocks.length);
    }

    const scores = scoreBlocks(blocks.map((block) => block.text), queryTokens, focus);
    const uniqueQuery = [...new Set(queryTokens)];
    const matchedTerms = blocks.map((block) => {
        const tokens = new Set(tokenize(block.text));
        return uniqueQuery.filter((term) => tokens.has(term)).length;
    });

    let bestIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < scores.length; index += 1) {
        const score = scores[index] ?? 0;
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }
    if (bestIndex < 0) {
        return emptySelection(blocks.length);
    }

    const ordered = scores
        .map((score, index) => ({ index, score }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);

    const chosen = new Set<number>();
    let used = 0;
    for (const entry of ordered) {
        const block = blocks[entry.index];
        if (!block) {
            continue;
        }
        const cost = block.text.length + 2;
        if (used + cost > maxChars && chosen.size > 0) {
            break;
        }
        chosen.add(entry.index);
        used += cost;
    }
    if (chosen.size === 0) {
        return emptySelection(blocks.length);
    }

    const indices = [...chosen].sort((left, right) => left - right);
    const parts: string[] = [];
    let previous = -1;
    for (const index of indices) {
        const block = blocks[index];
        if (!block) {
            continue;
        }
        const skipped = index - previous - 1;
        if (previous >= 0 && skipped >= 4) {
            parts.push(`[... ${skipped} unrelated blocks skipped ...]`);
        }
        const needsHeading = block.heading && !block.text.trimStart().startsWith('#');
        parts.push(needsHeading ? `## ${block.heading}\n\n${block.text}` : block.text);
        previous = index;
    }

    const first = blocks[indices[0] ?? 0];
    const last = blocks[indices[indices.length - 1] ?? 0];
    const content = parts.join('\n\n');

    return {
        content,
        selectedBlocks: indices.length,
        totalBlocks: blocks.length,
        start: first?.start ?? 0,
        end: last?.end ?? fullText.length,
        bestOffset: blocks[bestIndex]?.start ?? 0,
        matchedTerms: matchedTerms[bestIndex] ?? 0
    };
}
