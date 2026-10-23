import { describe, expect, it } from 'vitest';
import {
    buildJsdelivrUrl,
    contentBudgetMs,
    formatChangedFilesSection,
    isGithubContentCdnFirst,
    MAX_LISTED_CHANGED_FILES
} from '../../engines/github/contentBudget.js';

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

describe('github content budget', () => {
    it('accepts both the new and legacy CDN-first switch names', () => {
        expect(isGithubContentCdnFirst(env({ GITHUB_CONTENT_CDN_FIRST: 'true' }))).toBe(true);
        expect(isGithubContentCdnFirst(env({ GITHUB_README_CDN_FIRST: 'true' }))).toBe(true);
        expect(isGithubContentCdnFirst(env({}))).toBe(false);
    });

    it('uses the aggressive budget in CDN-first mode and honors the override', () => {
        expect(contentBudgetMs(env({ GITHUB_CONTENT_CDN_FIRST: 'true' }))).toBe(6000);
        expect(contentBudgetMs(env({}))).toBe(12000);
        expect(contentBudgetMs(env({ GITHUB_CONTENT_CDN_FIRST: 'true', GITHUB_CONTENT_BUDGET_MS: '8000' }))).toBe(8000);
    });

    it('builds the same jsDelivr path on alternate hosts', () => {
        expect(buildJsdelivrUrl('cdn.jsdelivr.net', 'o', 'r', '@main', 'README.md'))
            .toBe('https://cdn.jsdelivr.net/gh/o/r@main/README.md');
        expect(buildJsdelivrUrl('fastly.jsdelivr.net', 'o', 'r', '', 'a/b.ts'))
            .toBe('https://fastly.jsdelivr.net/gh/o/r/a/b.ts');
    });
});

describe('formatChangedFilesSection', () => {
    const files = Array.from({ length: 200 }, (_, index) => ({
        filename: `hutool-core/src/main/java/File${index}.java`,
        additions: 1,
        deletions: 1,
        status: 'modified'
    }));

    it('lists only the first 30 files and keeps the total in the trailer', () => {
        const lines = formatChangedFilesSection(files, 200);
        expect(lines[0]).toBe('');
        expect(lines[1]).toBe('## Changed Files (30 of 200)');
        expect(lines).toHaveLength(2 + MAX_LISTED_CHANGED_FILES + 1);
        expect(lines.at(-1)).toContain('… and 170 more');
    });

    it('does not add a trailer when everything fits', () => {
        const lines = formatChangedFilesSection(files.slice(0, 5), 5);
        expect(lines[1]).toBe('## Changed Files (5 of 5)');
        expect(lines.some((line) => line.includes('more'))).toBe(false);
    });

    it('never lists more than the max even if caller passes a bigger total', () => {
        const lines = formatChangedFilesSection(files.slice(0, 40), 40);
        expect(lines.filter((line) => line.startsWith('- `')).length).toBe(MAX_LISTED_CHANGED_FILES);
        expect(lines.at(-1)).toContain('… and 10 more');
    });
});
