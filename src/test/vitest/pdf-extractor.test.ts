import { describe, it, expect, afterEach } from 'vitest';
import type { AxiosResponse } from 'axios';
import {
    isPdfResponse,
    looksLikeScannedPdf,
    extractPdfText,
    __setPdfExtractorForTests
} from '../../engines/web/pdfExtractor.js';
import { tryHandlePdfFetch, PrimaryFetchContext } from '../../engines/web/stages.js';
import { AppError } from '../../core/errors.js';

describe('Transparent PDF Extractor', () => {
    afterEach(() => {
        __setPdfExtractorForTests(null);
    });

    it('detects PDF responses via Content-Type or %PDF- magic bytes', () => {
        const pdfHeader = Buffer.from('%PDF-1.4\n%test');
        const htmlHeader = Buffer.from('<!DOCTYPE html><html>');

        expect(isPdfResponse('application/pdf', htmlHeader)).toBe(true);
        expect(isPdfResponse('application/x-pdf', htmlHeader)).toBe(true);
        expect(isPdfResponse('text/html', pdfHeader)).toBe(true);
        expect(isPdfResponse('application/octet-stream', pdfHeader)).toBe(true);
        expect(isPdfResponse('text/html', htmlHeader)).toBe(false);
    });

    it('identifies scanned PDFs with no or virtually no text layer', () => {
        expect(looksLikeScannedPdf('')).toBe(true);
        expect(looksLikeScannedPdf('    \n\n\t  ')).toBe(true);
        expect(looksLikeScannedPdf('abc')).toBe(true);
        expect(looksLikeScannedPdf('This is a valid text layer with actual readable sentences and content.')).toBe(false);
    });

    it('rejects oversized PDF files (> 20 MB)', async () => {
        // Create an empty buffer simulating > 20MB
        const fakeLargePdf = Buffer.alloc(21 * 1024 * 1024);
        fakeLargePdf.write('%PDF-1.5', 0);

        await expect(extractPdfText(fakeLargePdf, { maxPages: 50 })).rejects.toThrow(/PDF file too large/i);
    });

    describe('PDF Paging and Focus Golden Contract', () => {
        function makePdfContext(options: {
            data: Buffer | string;
            contentType?: string;
            raw?: string;
            startIndex?: number;
            targetMaxChars?: number;
            url?: string;
            finalUrl?: string;
        }): PrimaryFetchContext {
            const url = options.url ?? 'https://example.com/docs/paper.pdf';
            const finalUrl = options.finalUrl ?? url;
            const parsedUrl = new URL(url);
            const contentType = options.contentType ?? 'application/pdf';
            const raw = options.raw ?? (typeof options.data === 'string' ? options.data : options.data.toString('binary'));
            return {
                url,
                parsedUrl,
                targetMaxChars: options.targetMaxChars ?? 1000,
                startIndex: options.startIndex ?? 0,
                response: {
                    status: 200,
                    statusText: 'OK',
                    headers: { 'content-type': contentType },
                    data: options.data,
                    config: {} as any,
                    request: { res: { responseUrl: finalUrl } }
                } as AxiosResponse,
                finalUrl,
                contentType,
                raw,
                usedBrowserCookies: false,
                retrievalMethod: 'request',
                withinCookieBudget: async (fn) => fn(),
                withinBrowserBudget: async (fn) => fn()
            };
        }

        // Exactly 1200 characters: 400 + 400 + 400
        const page1Text = '[page 1]\n' + 'A'.repeat(389) + '\n\n'; // 400 chars
        const page2Text = '[page 2]\n' + 'B'.repeat(389) + '\n\n'; // 400 chars
        const page3Text = '[page 3]\n' + 'C'.repeat(391);         // 400 chars
        const samplePdfText = page1Text + page2Text + page3Text; // exactly 1200 chars

        it('returns null when response is not a PDF (e.g. text/html)', async () => {
            const htmlContext = makePdfContext({
                url: 'https://example.com/page.html',
                data: '<html><body>Not a PDF</body></html>',
                contentType: 'text/html',
                raw: '<html><body>Not a PDF</body></html>'
            });
            const result = await tryHandlePdfFetch(htmlContext, {});
            expect(result).toBeNull();
        });

        it('pages through PDF document with explicit hasMore and nextStartIndex contract', async () => {
            __setPdfExtractorForTests(async () => ({
                text: samplePdfText,
                totalPages: 3,
                extractedPages: 3,
                title: 'Sample PDF Document'
            }));

            // Page 1: 0..500
            const ctx1 = makePdfContext({
                data: Buffer.from('%PDF-1.4 sample'),
                startIndex: 0,
                targetMaxChars: 500
            });
            const res1 = await tryHandlePdfFetch(ctx1, { startIndex: 0 });
            expect(res1).not.toBeNull();
            expect(res1!.contentType).toBe('application/pdf');
            expect(res1!.title).toBe('Sample PDF Document');
            expect(res1!.pdfPages).toBe(3);
            expect(res1!.totalLength).toBe(1200);
            expect(res1!.startIndex).toBe(0);
            expect(res1!.truncated).toBe(true);
            expect(res1!.hasMore).toBe(true);
            expect(res1!.nextStartIndex).toBe(500);
            expect(res1!.content).toBe(samplePdfText.slice(0, 500));

            // Page 2: 500..1000
            const ctx2 = makePdfContext({
                data: Buffer.from('%PDF-1.4 sample'),
                startIndex: 500,
                targetMaxChars: 500
            });
            const res2 = await tryHandlePdfFetch(ctx2, { startIndex: 500 });
            expect(res2).not.toBeNull();
            expect(res2!.startIndex).toBe(500);
            expect(res2!.truncated).toBe(true);
            expect(res2!.hasMore).toBe(true);
            expect(res2!.nextStartIndex).toBe(1000);
            expect(res2!.content).toBe(samplePdfText.slice(500, 1000));

            // Page 3 (Final page): 1000..1200
            const ctx3 = makePdfContext({
                data: Buffer.from('%PDF-1.4 sample'),
                startIndex: 1000,
                targetMaxChars: 500
            });
            const res3 = await tryHandlePdfFetch(ctx3, { startIndex: 1000 });
            expect(res3).not.toBeNull();
            expect(res3!.startIndex).toBe(1000);
            expect(res3!.truncated).toBe(false);
            expect(res3!.hasMore).toBeUndefined();
            expect(res3!.nextStartIndex).toBeUndefined();
            expect(res3!.content).toBe(samplePdfText.slice(1000, 1200));
        });

        it('throws start_index_out_of_range when startIndex >= totalLength', async () => {
            __setPdfExtractorForTests(async () => ({
                text: samplePdfText,
                totalPages: 3,
                extractedPages: 3,
                title: 'Sample PDF Document'
            }));

            const ctxOob = makePdfContext({
                data: Buffer.from('%PDF-1.4 sample'),
                startIndex: 1200,
                targetMaxChars: 500
            });

            await expect(tryHandlePdfFetch(ctxOob, { startIndex: 1200 })).rejects.toSatisfy((err: unknown) => {
                expect(err).toBeInstanceOf(AppError);
                const appErr = err as AppError;
                expect(appErr.code).toBe('start_index_out_of_range');
                expect(appErr.details).toMatchObject({ totalLength: 1200, startIndex: 1200 });
                return true;
            });
        });

        it('supports focus keyword matching and returns window snippet with metadata', async () => {
            const focusKeyword = 'CRITICAL_METRIC';
            // Total length 7000: 3000 'A' + 15 keyword + 3985 'B'
            const longPdfText = 'A'.repeat(3000) + focusKeyword + 'B'.repeat(3985);
            expect(longPdfText.length).toBe(7000);

            __setPdfExtractorForTests(async () => ({
                text: longPdfText,
                totalPages: 7,
                extractedPages: 7,
                title: 'Focus PDF Test'
            }));

            const ctxFocus = makePdfContext({
                data: Buffer.from('%PDF-1.4 sample'),
                startIndex: 0,
                targetMaxChars: 5000
            });
            const resFocus = await tryHandlePdfFetch(ctxFocus, { focus: focusKeyword });

            expect(resFocus).not.toBeNull();
            expect(resFocus!.focused).toBe(true);
            expect(resFocus!.focusMatchOffset).toBe(3000);
            // Window is [500, 5515], both prefix and suffix are attached
            expect(resFocus!.startIndex).toBe(500);
            expect(resFocus!.truncated).toBe(true);
            expect(resFocus!.hasMore).toBe(true);
            expect(resFocus!.nextStartIndex).toBe(500 + resFocus!.content.length);
            expect(resFocus!.content).toContain(`focused on "${focusKeyword}" at offset 3000, showing 500-5515 of 7000`);
            expect(resFocus!.content).toContain(`[... truncated; continue with startIndex=5515 or specify another focus ...]`);
            expect(resFocus!.content).toContain(focusKeyword);
            expect(resFocus!.pdfPages).toBe(7);
            expect(resFocus!.contentType).toBe('application/pdf');
        });
    });
});
