import { describe, expect, it } from 'vitest';
import { generateMarkdownOutline, paginateContent } from '../../engines/web/pagination.js';
import { extractContentFromJsonLd } from '../../engines/web/jsonLdExtractor.js';

describe('web outline and section navigation', () => {
    const sampleDoc = [
        '# Introduction',
        'Welcome to the comprehensive system documentation.',
        '',
        '## Quick Start {#getting-started}',
        'To get started, install the package via npm:',
        '```bash',
        'npm install my-package',
        '```',
        '',
        '## Configuration',
        'Here are the primary configuration options available:',
        '- `apiKey`: Your authentication key',
        '- `timeout`: Network request timeout in milliseconds',
        '',
        '### Advanced Settings',
        'For high throughput environments, tune the connection pool:',
        '```json',
        '{"maxConnections": 50}',
        '```',
        '',
        '## API Reference',
        'Detailed function signatures and return types.'
    ].join('\n');

    describe('generateMarkdownOutline', () => {
        it('extracts heading tree with slugs, custom IDs, levels, and character counts', () => {
            const outline = generateMarkdownOutline(sampleDoc);

            expect(outline).toHaveLength(5);
            expect(outline[0]?.title).toBe('Introduction');
            expect(outline[0]?.level).toBe(1);
            expect(outline[0]?.id).toBe('introduction');

            // Custom {#id} preserved
            expect(outline[1]?.title).toBe('Quick Start');
            expect(outline[1]?.id).toBe('getting-started');
            expect(outline[1]?.level).toBe(2);

            expect(outline[2]?.title).toBe('Configuration');
            expect(outline[2]?.id).toBe('configuration');
            expect(outline[2]?.level).toBe(2);

            expect(outline[3]?.title).toBe('Advanced Settings');
            expect(outline[3]?.id).toBe('advanced-settings');
            expect(outline[3]?.level).toBe(3);

            expect(outline[4]?.title).toBe('API Reference');
            expect(outline[4]?.id).toBe('api-reference');
        });
    });

    describe('paginateContent with outline mode', () => {
        it('returns structured outline view and metadata when mode="outline"', () => {
            const result = paginateContent(sampleDoc, {
                maxChars: 10000,
                mode: 'outline'
            });

            expect(result.truncated).toBe(false);
            expect(result.outline).toBeDefined();
            expect(result.outline).toHaveLength(5);
            expect(result.content).toContain('# Document Outline (5 sections');
            expect(result.content).toContain('**# Introduction** (id: `introduction`');
            expect(result.content).toContain('**## Quick Start** (id: `getting-started`');
            expect(result.content).toContain('**### Advanced Settings** (id: `advanced-settings`');
            expect(result.content).toContain('Use `sectionId="<id>"` with fetchWebContent');
        });
    });

    describe('paginateContent with sectionId targeting', () => {
        it('extracts target section and stops at the next same-level or higher heading', () => {
            const result = paginateContent(sampleDoc, {
                maxChars: 10000,
                sectionId: 'configuration'
            });

            expect(result.focused).toBe(true);
            expect(result.section?.id).toBe('configuration');
            expect(result.section?.title).toBe('Configuration');
            expect(result.content).toContain('Here are the primary configuration options available:');
            // Sub-sections included
            expect(result.content).toContain('### Advanced Settings');
            expect(result.content).toContain('{"maxConnections": 50}');
            // Next H2 excluded
            expect(result.content).not.toContain('## API Reference');
        });

        it('extracts sub-section and stops at the next heading', () => {
            const result = paginateContent(sampleDoc, {
                maxChars: 10000,
                sectionId: 'advanced-settings'
            });

            expect(result.focused).toBe(true);
            expect(result.section?.title).toBe('Advanced Settings');
            expect(result.content).toContain('{"maxConnections": 50}');
            expect(result.content).not.toContain('Here are the primary configuration options available:');
        });

        it('falls back with focusWarning when section is not found', () => {
            const result = paginateContent(sampleDoc, {
                maxChars: 10000,
                sectionId: 'non-existent-section'
            });

            expect(result.focused).toBeUndefined();
            expect(result.focusWarning).toContain('Section "non-existent-section" not found in document outline');
            expect(result.content).toContain('Welcome to the comprehensive system documentation.');
        });
    });
});

describe('JSON-LD structured content extraction', () => {
    describe('FAQPage / QAPage', () => {
        it('extracts FAQ Q&A pairs directly into high-signal markdown', () => {
            const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script type="application/ld+json">
                {
                    "@context": "https://schema.org",
                    "@type": "FAQPage",
                    "name": "General Troubleshooting FAQ",
                    "mainEntity": [
                        {
                            "@type": "Question",
                            "name": "How do I reset my credentials?",
                            "acceptedAnswer": {
                                "@type": "Answer",
                                "text": "<p>Navigate to <code>Settings &gt; Security</code> and click <b>Reset Key</b>.</p>"
                            }
                        },
                        {
                            "@type": "Question",
                            "name": "What is the request rate limit?",
                            "acceptedAnswer": {
                                "@type": "Answer",
                                "text": "The rate limit is 100 requests per minute per IP."
                            }
                        }
                    ]
                }
                </script>
            </head>
            <body><p>Unused sidebar noise</p></body>
            </html>
            `;

            const res = extractContentFromJsonLd(html);
            expect(res).not.toBeNull();
            expect(res?.type).toBe('faq');
            expect(res?.title).toBe('General Troubleshooting FAQ');
            expect(res?.markdown).toContain('# General Troubleshooting FAQ');
            expect(res?.markdown).toContain('### Q: How do I reset my credentials?');
            expect(res?.markdown).toContain('Navigate to Settings > Security and click Reset Key.');
            expect(res?.markdown).toContain('### Q: What is the request rate limit?');
            expect(res?.markdown).toContain('The rate limit is 100 requests per minute per IP.');
            expect(res?.markdown).not.toContain('Unused sidebar noise');
        });
    });

    describe('HowTo', () => {
        it('extracts steps into clean ordered instructions markdown', () => {
            const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script type="application/ld+json">
                {
                    "@context": "https://schema.org",
                    "@type": "HowTo",
                    "name": "How to Configure TLS 1.3",
                    "description": "Step by step guide to enabling TLS 1.3 in Nginx.",
                    "step": [
                        {
                            "@type": "HowToStep",
                            "name": "Edit Nginx Configuration",
                            "text": "Open /etc/nginx/nginx.conf in your favorite editor."
                        },
                        {
                            "@type": "HowToStep",
                            "name": "Specify TLS Protocols",
                            "text": "Add ssl_protocols TLSv1.2 TLSv1.3; inside the http block."
                        }
                    ]
                }
                </script>
            </head>
            <body><div class="ad">Advertisements</div></body>
            </html>
            `;

            const res = extractContentFromJsonLd(html);
            expect(res).not.toBeNull();
            expect(res?.type).toBe('howto');
            expect(res?.title).toBe('How to Configure TLS 1.3');
            expect(res?.markdown).toContain('# How to Configure TLS 1.3');
            expect(res?.markdown).toContain('Step by step guide to enabling TLS 1.3 in Nginx.');
            expect(res?.markdown).toContain('1. **Edit Nginx Configuration**\n   Open /etc/nginx/nginx.conf in your favorite editor.');
            expect(res?.markdown).toContain('2. **Specify TLS Protocols**\n   Add ssl_protocols TLSv1.2 TLSv1.3; inside the http block.');
            expect(res?.markdown).not.toContain('Advertisements');
        });
    });

    describe('Article / TechArticle gate threshold', () => {
        it('extracts full article when articleBody is >= 500 characters', () => {
            const longArticleBody = 'Modern web search engines employ a variety of heuristic ranking models and machine learning pipelines. '.repeat(10);
            expect(longArticleBody.length).toBeGreaterThan(500);

            const html = `
            <script type="application/ld+json">
            {
                "@context": "https://schema.org",
                "@type": "TechArticle",
                "headline": "Understanding Search Rank Fusion",
                "author": { "@type": "Person", "name": "Jane Doe" },
                "articleBody": "${longArticleBody}"
            }
            </script>
            `;

            const res = extractContentFromJsonLd(html);
            expect(res).not.toBeNull();
            expect(res?.type).toBe('article');
            expect(res?.title).toBe('Understanding Search Rank Fusion');
            expect(res?.markdown).toContain('# Understanding Search Rank Fusion');
            expect(res?.markdown).toContain('*By Jane Doe*');
            expect(res?.markdown).toContain('Modern web search engines employ a variety of heuristic');
        });

        it('rejects short articleBody (< 500 chars) to let Readability/DOM extract full content', () => {
            const shortSummary = 'This is just a 50-character summary snippet.';
            const html = `
            <script type="application/ld+json">
            {
                "@context": "https://schema.org",
                "@type": "Article",
                "headline": "Short Post",
                "articleBody": "${shortSummary}"
            }
            </script>
            `;

            const res = extractContentFromJsonLd(html);
            // Returns null so stages.ts safely falls back to Readability/DOM parser
            expect(res).toBeNull();
        });
    });
});
