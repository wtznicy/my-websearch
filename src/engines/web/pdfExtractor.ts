import path from 'node:path';
import { AppError } from '../../core/errors.js';

export interface PdfExtractionResult {
    text: string;
    totalPages: number;
    extractedPages: number;
    title?: string;
}

export const MAX_PDF_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_PDF_PAGES = 50;

export function isPdfResponse(
    contentType?: string,
    bufferOrString?: Uint8Array | ArrayBuffer | Buffer | string,
    url?: string
): boolean {
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('application/pdf') || ct.includes('application/x-pdf')) {
        return true;
    }
    if (url) {
        try {
            const parsed = new URL(url);
            if (parsed.pathname.toLowerCase().endsWith('.pdf')) {
                return true;
            }
        } catch {
            if (url.toLowerCase().endsWith('.pdf')) {
                return true;
            }
        }
    }
    if (bufferOrString) {
        if (typeof bufferOrString === 'string') {
            return bufferOrString.startsWith('%PDF-');
        }
        const bytes = bufferOrString instanceof Uint8Array
            ? bufferOrString
            : new Uint8Array(bufferOrString);
        if (bytes.length >= 5) {
            // %PDF- magic bytes: 0x25, 0x50, 0x44, 0x46, 0x2d
            return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
        }
    }
    return false;
}

export function looksLikeScannedPdf(text: string): boolean {
    const cleaned = (text || '').replace(/\s+/g, '');
    return cleaned.length < 10;
}

export async function extractPdfText(
    buffer: ArrayBuffer | Uint8Array,
    options: { maxPages?: number; url?: string } = {}
): Promise<PdfExtractionResult> {
    const maxPages = options.maxPages ?? MAX_PDF_PAGES;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let unpdfModule: any;
    try {
        unpdfModule = await import('unpdf');
    } catch {
        throw new AppError({
            code: 'missing_optional_dependency',
            message: 'unpdf is not available (optional dependency not installed); PDF parsing is disabled',
            retryable: false
        });
    }

    const byteLen = buffer instanceof Uint8Array ? buffer.byteLength : buffer.byteLength;
    if (byteLen > MAX_PDF_DOWNLOAD_BYTES) {
        throw new AppError({
            code: 'response_too_large',
            details: { legacyCode: 'ERR_RESPONSE_TOO_LARGE', byteLength: byteLen, maxBytes: MAX_PDF_DOWNLOAD_BYTES },
            message: `PDF file too large (${byteLen} bytes). Max allowed is ${MAX_PDF_DOWNLOAD_BYTES} bytes (20MB)`,
            retryable: false
        });
    }

    try {
        const { extractText, getMeta } = unpdfModule;
        const res = await extractText(buffer, { mergePages: false });
        const totalPages = res.totalPages;
        if (!totalPages || totalPages === 0) {
            throw new AppError({
                code: 'pdf_no_text_layer',
                message: 'PDF contains 0 pages or invalid structure',
                retryable: false
            });
        }

        const pagesArray = Array.isArray(res.text) ? res.text : [res.text];
        const pagesToExtract = Math.min(totalPages, maxPages);
        const pageSections: string[] = [];
        let totalExtractedLength = 0;

        for (let i = 0; i < pagesToExtract; i++) {
            const pageNum = i + 1;
            const rawPageText = (pagesArray[i] || '').trim();
            totalExtractedLength += rawPageText.length;
            pageSections.push(`[page ${pageNum}]\n${rawPageText}`);
        }

        if (totalExtractedLength < 10) {
            throw new AppError({
                code: 'pdf_no_text_layer',
                message: 'PDF contains no extractable text layer (scanned document or image-only PDF). OCR is required to extract text.',
                retryable: false
            });
        }

        let title: string | undefined;
        try {
            const meta = await getMeta(buffer);
            if (meta?.info && typeof meta.info === 'object' && 'Title' in meta.info && typeof meta.info.Title === 'string' && meta.info.Title.trim()) {
                title = meta.info.Title.trim();
            }
        } catch {
            // ignore meta failure
        }

        if (!title && options.url) {
            try {
                const parsed = new URL(options.url);
                const baseName = path.basename(parsed.pathname).replace(/\.pdf$/i, '');
                if (baseName) {
                    title = decodeURIComponent(baseName);
                }
            } catch {
                // ignore
            }
        }

        let text = pageSections.join('\n\n');
        if (totalPages > maxPages) {
            text += `\n\n[... PDF truncated: extracted ${pagesToExtract} of ${totalPages} total pages ...]`;
        }

        return {
            text,
            totalPages,
            extractedPages: pagesToExtract,
            title
        };
    } catch (error) {
        if (error instanceof AppError) {
            throw error;
        }
        throw new AppError({
            code: 'pdf_parse_error',
            message: `Failed to parse PDF document: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false
        });
    }
}
