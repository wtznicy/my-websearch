import { AppError } from '../../core/errors.js';

/** 单次返回的最大代码行数：超过则截断并明确提示，避免单个大文件冲爆上下文 */
export const MAX_LINE_RANGE = 400;

export interface LineRange {
    start: number;
    end: number;
}

function invalid(message: string): AppError {
    return new AppError({
        code: 'invalid_arguments',
        retryable: false,
        engine: 'github',
        message,
        hint: 'Use lines like "120-180" (or a URL hash such as #L120-L180); 1-based, inclusive.'
    });
}

/**
 * 解析显式 `lines` 参数：
 *   "120-180" / "120" / "L120-L180"
 */
export function parseLineRangeInput(raw?: string): LineRange | undefined {
    if (!raw || !raw.trim()) {
        return undefined;
    }
    const match = raw.trim().match(/^L?(\d+)(?:\s*[-–]\s*L?(\d+))?$/i);
    if (!match) {
        throw invalid(`Invalid lines value "${raw}".`);
    }
    const start = Number.parseInt(match[1]!, 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
        throw invalid(`Invalid lines value "${raw}": start must be >= 1 and end must be >= start.`);
    }
    return { start, end };
}

/**
 * 从 GitHub/Gitee URL 的 hash 解析行号：
 *   #L120-L180 / #L120
 */
export function parseLineRangeFromUrl(url: string): LineRange | undefined {
    try {
        const hash = new URL(url.trim()).hash.replace(/^#/, '');
        if (!hash) {
            return undefined;
        }
        return parseLineRangeInput(hash);
    } catch (error) {
        if (error instanceof AppError) {
            throw error;
        }
        return undefined;
    }
}

export interface SlicedLines {
    lines: string[];
    total: number;
    start: number;
    end: number;
    truncated: boolean;
}

/**
 * 按 1-based 闭区间切片；起始行越界直接报错（不静默返回全文），
 * 超过 MAX_LINE_RANGE 时截断到上限并标记 truncated。
 */
export function sliceCodeLines(content: string, range: LineRange): SlicedLines {
    const all = content.split(/\r?\n/);
    const total = all.length;
    if (range.start > total) {
        throw invalid(`Requested start line ${range.start} exceeds file length ${total}.`);
    }
    const requestedEnd = Math.min(range.end, total);
    const cappedEnd = Math.min(requestedEnd, range.start + MAX_LINE_RANGE - 1);
    return {
        lines: all.slice(range.start - 1, cappedEnd),
        total,
        start: range.start,
        end: cappedEnd,
        truncated: cappedEnd < requestedEnd
    };
}
