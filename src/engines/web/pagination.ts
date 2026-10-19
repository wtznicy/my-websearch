import { AppError } from '../../core/errors.js';
import { FetchWebContentResult } from './types.js';

export interface PaginateOptions {
    startIndex?: number;
    maxChars: number;
    focus?: string;
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

    if (options.focus && options.focus.trim()) {
        const focusTerm = options.focus.trim().toLowerCase();
        const lowerContent = fullText.toLowerCase();
        const focusIdx = lowerContent.indexOf(focusTerm);
        if (focusIdx !== -1) {
            focused = true;
            focusMatchOffset = focusIdx;
            const windowSize = 2500;
            const start = Math.max(0, focusIdx - windowSize);
            const end = Math.min(totalLength, focusIdx + focusTerm.length + windowSize);
            const snippet = fullText.slice(start, end);
            const prefix = start > 0 ? `[... focused on "${options.focus}" at offset ${focusIdx}, showing ${start}-${end} of ${totalLength} ...]\n\n` : '';
            const suffix = end < totalLength ? `\n\n[... truncated; continue with startIndex=${end} or specify another focus ...]` : '';
            pageContent = `${prefix}${snippet}${suffix}`;
            startIndex = start;
            truncated = start > 0 || end < totalLength;
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

    return {
        content,
        totalLength,
        startIndex,
        truncated,
        ...(truncated ? { hasMore: true, nextStartIndex: startIndex + pageContent.length } : {}),
        ...(toc && toc.length > 0 ? { toc } : {}),
        ...(focused ? { focused: true, focusMatchOffset } : {})
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
        cached?: boolean;
        warnings?: string[];
        pdfPages?: number;
    }
): FetchWebContentResult {
    const paginated = paginateContent(fullText, {
        startIndex: options.startIndex,
        maxChars: options.maxChars,
        focus: options.focus,
        appendTruncationMarker: false,
        generateToc: true
    });

    return {
        url: options.url,
        finalUrl: options.finalUrl || options.url,
        contentType: options.contentType || 'text/markdown',
        title: options.title,
        siteName: options.siteName,
        retrievalMethod: 'request',
        truncated: paginated.truncated,
        content: paginated.content,
        totalLength: paginated.totalLength,
        startIndex: paginated.startIndex,
        hasMore: paginated.hasMore,
        nextStartIndex: paginated.nextStartIndex,
        cached: options.cached ?? false,
        ...(options.warnings && options.warnings.length > 0 ? { warnings: options.warnings } : {}),
        ...(options.pdfPages ? { pdfPages: options.pdfPages } : {}),
        ...(paginated.toc && paginated.toc.length > 0 ? { toc: paginated.toc } : {}),
        ...(paginated.focused ? { focused: true, focusMatchOffset: paginated.focusMatchOffset } : {})
    };
}
