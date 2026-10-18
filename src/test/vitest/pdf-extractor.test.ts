import { describe, it, expect } from 'vitest';
import {
    isPdfResponse,
    looksLikeScannedPdf,
    extractPdfText
} from '../../engines/web/pdfExtractor.js';

describe('Transparent PDF Extractor', () => {
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
});
