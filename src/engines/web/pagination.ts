import { AppError } from '../../core/errors.js';
import { addCitations } from '../../utils/citations.js';
import { selectFocusBlocks } from '../../utils/bm25.js';
import { applyLinkRetention, type LinkRetentionMode } from '../../utils/linkRetention.js';
import { FetchWebContentResult, FocusMode } from './types.js';

export interface PaginateOptions {
    startIndex?: number;
    maxChars: number;
    focus?: string;
    /** bm25（默认）：按段落相关性选块；window：旧的「首次命中 ±2500 字」固定窗口 */
    focusMode?: FocusMode;
    appendTruncationMarker?: boolean;
    generateToc?: boolean;
}

export interface PaginateResult {
    content: string;
    totalLength: number;
    startIndex: number;
    truncated: boolean;
    hasMore?: boolean;
    nextStartIndex?: number;
    focused?: boolean;
    focusMatchOffset?: number;
    focusMode?: FocusMode;
    focusBlocks?: { selected: number; total: number };
    /** focus 未命中时的说明（也会并入 warnings） */
    focusWarning?: string;
    toc?: string[];
}

export function generateMarkdownToc(markdown: string): string[] {
    const headingRegex = /(?:^|\n)(#{1,3})\s+([^\n\r]+)/g;
    const toc: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = headingRegex.exec(markdown)) !== null) {
        const level = match[1];
        const title = match[2]?.trim() ?? '';
        const offset = match.index + (match[0].startsWith('\n') ? 1 : 0);
        if (title) {
            const cleanTitle = title.length > 50 ? title.slice(0, 47) + '...' : title;
            toc.push(`${level} ${cleanTitle} (${offset})`);
        }
    }
    return toc;
}

export function paginateContent(
    fullText: string,
    options: PaginateOptions
): PaginateResult {
    const totalLength = fullText.length;
    let startIndex = Math.max(0, Math.floor(options.startIndex ?? 0));
    let pageContent = '';
    let truncated = false;
    let focused = false;
    let focusMatchOffset: number | undefined;
    let resolvedFocusMode: FocusMode | undefined;
    let focusBlocks: { selected: number; total: number } | undefined;

    const focusTerm = options.focus?.trim();
    let focusWarning: string | undefined;
    let bm25Missed = false;
    if (focusTerm) {
        // bm25（默认）：按段落相关性挑块，解决「只命中第一次出现 + 只给一段连续窗口」的问题
        if ((options.focusMode ?? 'bm25') === 'bm25') {
            // 预留 header 与分隔符空间，避免选块把 maxChars 撑爆
            const selection = selectFocusBlocks(fullText, focusTerm, Math.max(400, options.maxChars - 200));
            if (selection.selectedBlocks > 0) {
                focused = true;
                resolvedFocusMode = 'bm25';
                focusBlocks = { selected: selection.selectedBlocks, total: selection.totalBlocks };
                focusMatchOffset = selection.bestOffset;
                startIndex = selection.start;
                // 选块必然丢弃了部分正文，因此标记截断；但偏移不连续，
                // 所以不提供 nextStartIndex 续读指针（续读只对 window/普通分页有意义）
                truncated = true;
                pageContent = `[... focused on "${focusTerm}" (bm25): ${selection.selectedBlocks}/${selection.totalBlocks} blocks selected by relevance, doc offsets ${selection.start}-${selection.end} of ${totalLength} ...]\n\n${selection.content}`;
            } else if (selection.totalBlocks > 0) {
                // 零命中也要把事实暴露出来：matched 0 of N，而不是静默退回整页
                bm25Missed = true;
                focusBlocks = { selected: 0, total: selection.totalBlocks };
            }
        }

        // 显式 window 模式，或 bm25 没命中任何块时的回退
        if (!focused) {
            const focusTermLower = focusTerm.toLowerCase();
            const lowerContent = fullText.toLowerCase();
            const focusIdx = lowerContent.indexOf(focusTermLower);
            if (focusIdx !== -1) {
                focused = true;
                resolvedFocusMode = 'window';
                focusMatchOffset = focusIdx;
                const windowSize = 2500;
                const start = Math.max(0, focusIdx - windowSize);
                const end = Math.min(totalLength, focusIdx + focusTermLower.length + windowSize);
                const snippet = fullText.slice(start, end);
                const prefix = start > 0 ? `[... focused on "${focusTerm}" at offset ${focusIdx}, showing ${start}-${end} of ${totalLength} ...]\n\n` : '';
                const suffix = end < totalLength ? `\n\n[... truncated; continue with startIndex=${end} or specify another focus ...]` : '';
                pageContent = `${prefix}${snippet}${suffix}`;
                startIndex = start;
                truncated = start > 0 || end < totalLength;
            }
        }

        if (bm25Missed) {
            const total = focusBlocks?.total ?? 0;
            focusWarning = focused && resolvedFocusMode === 'window'
                ? `BM25 matched 0 of ${total} blocks; fell back to window mode (±2500 chars around the first literal occurrence).`
                : `focus term "${focusTerm}" matched 0 of ${total} blocks; returned the full page (the term may be absent, or it may tokenize to nothing after stop-word removal).`;
        }
    }

    if (!focused) {
        if (startIndex >= totalLength && totalLength > 0) {
            throw new AppError({
                code: 'start_index_out_of_range',
                retryable: false,
                details: { legacyCode: 'ERR_START_INDEX_OUT_OF_RANGE', totalLength, startIndex },
                hint: `当前正文实际总长度为 totalLength=${totalLength}，请将 startIndex 设为小于 ${totalLength} 的偏移量（或重置为 0 从头读取）。`,
                message: `startIndex ${startIndex} is beyond content length ${totalLength}; reset to 0 to read from the beginning`
            });
        }
        pageContent = fullText.slice(startIndex, startIndex + options.maxChars);
        truncated = startIndex + options.maxChars < totalLength;
    }

    const content = (!focused && truncated && options.appendTruncationMarker)
        ? `${pageContent}\n\n[truncated; continue with startIndex=${startIndex + pageContent.length}]`
        : pageContent;

    const toc = (truncated && options.generateToc !== false) ? generateMarkdownToc(fullText) : undefined;

    const canContinue = !(resolvedFocusMode === 'bm25');
    return {
        content,
        totalLength,
        startIndex,
        truncated,
        ...(truncated && canContinue ? { hasMore: true, nextStartIndex: startIndex + pageContent.length } : {}),
        ...(toc && toc.length > 0 ? { toc } : {}),
        // 有 focus 就显式给 true/false：false 表示"传了 focus 但没定位成功"，与"没传 focus"区分开
        ...(focusTerm ? { focused } : {}),
        ...(focused ? { focusMatchOffset } : {}),
        ...(resolvedFocusMode ? { focusMode: resolvedFocusMode } : {}),
        ...(focusBlocks ? { focusBlocks } : {}),
        ...(focusWarning ? { focusWarning } : {})
    };
}

/**
 * 从完整的 Markdown 字符串中执行统一的切片/聚焦/目录生成
 */
export function sliceMarkdownContent(
    fullText: string,
    options: {
        url: string;
        finalUrl?: string;
        title: string;
        siteName?: string;
        contentType?: string;
        startIndex?: number;
        maxChars: number;
        focus?: string;
        focusMode?: FocusMode;
        /** 把正文行内链接改写成正文编号 + 末尾 References 列表（仅在切片之后做，避免污染磁盘缓存） */
        citations?: boolean;
        /** 行内链接保留策略：all（默认）/ text（只留锚文本）/ none（整条移除） */
        retainLinks?: LinkRetentionMode;
        cached?: boolean;
        warnings?: string[];
        pdfPages?: number;
        /** 从上游提取阶段透传的元数据：切片会重建结果对象，不显式带过来就会丢 */
        links?: FetchWebContentResult['links'];
        byline?: string;
        excerpt?: string;
        readabilityApplied?: boolean;
        degraded?: string[];
        scoped?: FetchWebContentResult['scoped'];
    }
): FetchWebContentResult {
    const paginated = paginateContent(fullText, {
        startIndex: options.startIndex,
        maxChars: options.maxChars,
        focus: options.focus,
        focusMode: options.focusMode,
        appendTruncationMarker: false,
        generateToc: true
    });

    let content = paginated.content;
    // 按字符切片可能把 markdown 链接截成 `[text](`，留在末尾会显示成坏语法
    if (paginated.truncated) {
        content = content.replace(/\[[^\]\n]*\]\([^)\s]*$/, '').trimEnd();
    }
    let citationMeta: { references: number; uncited: number } | undefined;
    let retentionMeta: { mode: LinkRetentionMode; links: number } | undefined;
    if (options.retainLinks && options.retainLinks !== 'all') {
        const retained = applyLinkRetention(content, options.retainLinks);
        content = retained.content;
        retentionMeta = { mode: options.retainLinks, links: retained.links };
    }
    if (options.citations) {
        const cited = addCitations(content, { baseUrl: options.finalUrl || options.url });
        content = cited.content;
        if (cited.references > 0) {
            citationMeta = { references: cited.references, uncited: cited.uncited };
        }
    }

    const mergedWarnings = [...(options.warnings ?? [])];
    if (paginated.focusWarning) {
        mergedWarnings.push(paginated.focusWarning);
    }

    return {
        url: options.url,
        finalUrl: options.finalUrl || options.url,
        contentType: options.contentType || 'text/markdown',
        title: options.title,
        siteName: options.siteName,
        retrievalMethod: 'request',
        truncated: paginated.truncated,
        content,
        totalLength: paginated.totalLength,
        startIndex: paginated.startIndex,
        hasMore: paginated.hasMore,
        nextStartIndex: paginated.nextStartIndex,
        cached: options.cached ?? false,
        ...(citationMeta ? { citations: citationMeta } : {}),
        ...(retentionMeta ? { retainLinks: retentionMeta } : {}),
        ...(options.links && options.links.length > 0 ? { links: options.links } : {}),
        ...(options.byline ? { byline: options.byline } : {}),
        ...(options.excerpt ? { excerpt: options.excerpt } : {}),
        ...(options.readabilityApplied !== undefined ? { readabilityApplied: options.readabilityApplied } : {}),
        ...(options.degraded && options.degraded.length > 0 ? { degraded: options.degraded } : {}),
        ...(options.scoped ? { scoped: options.scoped } : {}),
        ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
        ...(options.pdfPages ? { pdfPages: options.pdfPages } : {}),
        ...(paginated.toc && paginated.toc.length > 0 ? { toc: paginated.toc } : {}),
        ...(options.focus?.trim() ? { focused: paginated.focused ?? false } : {}),
        ...(paginated.focused ? { focusMatchOffset: paginated.focusMatchOffset } : {}),
        ...(paginated.focusMode ? { focusMode: paginated.focusMode } : {}),
        ...(paginated.focusBlocks ? { focusBlocks: paginated.focusBlocks } : {})
    };
}
