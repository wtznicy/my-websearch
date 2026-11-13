import { describe, expect, it } from 'vitest';
import { distillMarkdownSnippets, stripReadmeBoilerplate } from '../../core/docs/snippetDistiller.js';

describe('stripReadmeBoilerplate', () => {
    it('strips badges and tailing sponsors/license sections', () => {
        const readme = [
            '# Express',
            '',
            '[![NPM Version](https://img.shields.io/npm/v/express.svg)](https://npmjs.org/package/express)',
            '[![Build Status](https://github.com/expressjs/express/actions/workflows/ci.yml/badge.svg)](https://github.com)',
            '<p align="center"><img src="logo.png"></p>',
            '',
            'Fast, unopinionated, minimalist web framework for Node.js.',
            '',
            '## Table of Contents',
            '- [Installation](#installation)',
            '- [Quick Start](#quick-start)',
            '',
            '## Installation',
            '```bash',
            'npm install express',
            '```',
            '',
            '## Sponsors',
            '* [Sponsor A](https://sponsor.com)',
            '* [Sponsor B](https://sponsor.com)',
            '',
            '## License',
            'MIT License Copyright 2026'
        ].join('\n');

        const cleaned = stripReadmeBoilerplate(readme);
        expect(cleaned).not.toContain('img.shields.io');
        expect(cleaned).not.toContain('Sponsor A');
        expect(cleaned).not.toContain('MIT License Copyright');
        expect(cleaned).not.toContain('Table of Contents');
        expect(cleaned).toContain('Fast, unopinionated, minimalist web framework');
        expect(cleaned).toContain('npm install express');
    });
});

describe('distillMarkdownSnippets', () => {
    const sampleDoc = [
        '# Demo Library',
        '',
        'A comprehensive toolkit for async network operations.',
        '',
        '## Quick Start',
        'Here is how you start the server in two lines:',
        '```typescript',
        'import { Server } from "demo";',
        'const app = new Server();',
        'app.listen(8080);',
        '```',
        '',
        '## Routing and Middleware',
        'Create modular route middleware handlers for authentication:',
        '```typescript',
        'app.use((req, res, next) => {',
        '    if (!req.headers.auth) throw new Error("Unauthorized");',
        '    next();',
        '});',
        '```',
        '',
        '## Database Connection',
        'Connect to PostgreSQL database pool:',
        '```typescript',
        'const pool = createPool({ host: "localhost", port: 5432 });',
        '```',
        '',
        '## Sponsors',
        'Thanks to our generous backers!'
    ].join('\n');

    it('extracts structured code snippets with pageTitle, codeTitle and description', () => {
        const distilled = distillMarkdownSnippets(sampleDoc);
        expect(distilled.codeSnippets.length).toBeGreaterThanOrEqual(3);

        const first = distilled.codeSnippets[0]!;
        expect(first.pageTitle).toBe('Quick Start');
        expect(first.codeDescription).toContain('start the server in two lines');
        expect(first.codeList[0]?.code).toContain('app.listen(8080)');
        expect(first.codeList[0]?.language).toBe('typescript');
    });

    it('focuses and prioritises snippets matching query via BM25', () => {
        const distilled = distillMarkdownSnippets(sampleDoc, { query: 'middleware auth' });
        expect(distilled.codeSnippets.length).toBeGreaterThanOrEqual(1);

        // 包含 middleware / auth 的片段应当排在第一位
        const top = distilled.codeSnippets[0]!;
        expect(top.pageTitle).toBe('Routing and Middleware');
        expect(top.codeList[0]?.code).toContain('Unauthorized');
    });

    it('captures overview paragraph', () => {
        const distilled = distillMarkdownSnippets(sampleDoc);
        expect(distilled.overview).toBe('A comprehensive toolkit for async network operations.');
    });
});
