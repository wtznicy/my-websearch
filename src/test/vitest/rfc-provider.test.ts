import { describe, expect, it, vi } from 'vitest';
import {
    isLikelyRfcTarget,
    parseRfcSpecifier,
    cleanRfcText,
    extractRfcSection,
    extractRfcOverview,
    queryRfcDocs
} from '../../core/docs/rfcProvider.js';
import * as httpRequest from '../../utils/httpRequest.js';

describe('rfcProvider', () => {
    describe('isLikelyRfcTarget', () => {
        it('identifies RFC patterns', () => {
            expect(isLikelyRfcTarget('rfc:9110')).toBe(true);
            expect(isLikelyRfcTarget('rfc9110')).toBe(true);
            expect(isLikelyRfcTarget('RFC 8446')).toBe(true);
            expect(isLikelyRfcTarget('rfc:7231#section-5')).toBe(true);
            expect(isLikelyRfcTarget('react')).toBe(false);
            expect(isLikelyRfcTarget('express')).toBe(false);
        });
    });

    describe('parseRfcSpecifier', () => {
        it('parses rfc numbers and optional sections', () => {
            expect(parseRfcSpecifier('rfc:9110')).toEqual({ rfcNumber: 9110 });
            expect(parseRfcSpecifier('rfc9110')).toEqual({ rfcNumber: 9110 });
            expect(parseRfcSpecifier('rfc:9110#section-5.3')).toEqual({ rfcNumber: 9110, section: 'section-5.3' });
            expect(parseRfcSpecifier('rfc:9110', 'section 6.1')).toEqual({ rfcNumber: 9110, section: '6.1' });
            expect(parseRfcSpecifier('not-an-rfc')).toBeNull();
        });
    });

    describe('cleanRfcText', () => {
        it('strips form-feed and page headers/footers, unwarps prose while keeping indented blocks', () => {
            const rawRfc = [
                'Internet Engineering Task Force (IETF)                     R. Fielding',
                'Request for Comments: 9110                                       Adobe',
                'Category: Standards Track                                    June 2022',
                '',
                'HTTP Semantics',
                '',
                'Abstract',
                '',
                '   The Hypertext Transfer Protocol (HTTP) is a stateless',
                '   application-level protocol for distributed, collaborative, hypertext',
                '   information systems.',
                '',
                'Fielding, et al.            Standards Track                    [Page 1]',
                '\f',
                'RFC 9110                     HTTP Semantics                     June 2022',
                '',
                '1.  Introduction',
                '',
                '   HTTP is a stateless application-level request/response protocol.',
                '   Here is an example header frame:',
                '',
                '      GET /index.html HTTP/1.1',
                '      Host: example.com',
                '      User-Agent: MyTest/1.0',
                '',
                '   The protocol is extensible and widely used.'
            ].join('\n');

            const cleaned = cleanRfcText(rawRfc);

            // Page headers and footers stripped
            expect(cleaned).not.toContain('[Page 1]');
            expect(cleaned).not.toContain('\f');

            // Prose is unwrapped into single line
            expect(cleaned).toContain('The Hypertext Transfer Protocol (HTTP) is a stateless application-level protocol');

            // Indented block preserved intact
            expect(cleaned).toContain('      GET /index.html HTTP/1.1\n      Host: example.com');
        });
    });

    describe('extractRfcSection', () => {
        const sampleText = [
            '1. Introduction',
            'This is the introduction.',
            '',
            '2. Architecture',
            '2.1. Client Server',
            'Client and server communicate via request and response.',
            '',
            '2.2. Intermediaries',
            'Proxies, gateways, and tunnels are intermediaries.',
            '',
            '3. Security Considerations',
            'Always use TLS encryption.'
        ].join('\n');

        it('extracts specific section by number', () => {
            const res = extractRfcSection(sampleText, '2.1');
            expect(res).not.toBeNull();
            expect(res?.title).toBe('2.1 Client Server');
            expect(res?.content).toContain('Client and server communicate via request and response.');
            expect(res?.content).not.toContain('2.2. Intermediaries');
        });

        it('extracts section by keyword', () => {
            const res = extractRfcSection(sampleText, 'intermediaries');
            expect(res).not.toBeNull();
            expect(res?.title).toBe('2.2 Intermediaries');
            expect(res?.content).toContain('Proxies, gateways, and tunnels are intermediaries.');
            expect(res?.content).not.toContain('3. Security Considerations');
        });
    });

    describe('queryRfcDocs', () => {
        it('fetches and returns RFC docs', async () => {
            const mockRfcData = [
                'Request for Comments: 9110',
                '',
                'Abstract',
                '',
                '   HTTP Semantics specification.',
                '',
                '5.3. Header Fields',
                '   Header fields provide request and response metadata.',
                '',
                '5.4. Content Negotiation',
                '   Negotiates media types.'
            ].join('\n');

            const spy = vi.spyOn(httpRequest, 'requestDirectFirst').mockResolvedValueOnce({
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as any,
                data: mockRfcData
            });

            const res = await queryRfcDocs({
                library: 'rfc:9110',
                query: 'section 5.3'
            });

            expect(res).not.toBeNull();
            expect(res?.source).toBe('rfc');
            expect(res?.libraryId).toBe('rfc:9110');
            expect(res?.documentationUrl).toBe('https://www.rfc-editor.org/rfc/rfc9110.txt');
            expect(res?.content).toContain('5.3 Header Fields');
            expect(res?.content).toContain('Header fields provide request and response metadata.');
            expect(res?.content).not.toContain('5.4. Content Negotiation');

            spy.mockRestore();
        });
    });
});
