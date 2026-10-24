import { describe, expect, it } from 'vitest';
import { renderCommit, renderCompare, renderReleases } from '../../engines/github/changes.js';

describe('GitHub commit / compare / release rendering', () => {
    it('renders commit metadata, file table and patch', () => {
        const text = renderCommit({
            sha: 'abcdef1234567890',
            message: 'fix: something\n\nbody',
            author: 'Alice',
            date: '2026-01-01T00:00:00Z',
            stats: { additions: 3, deletions: 1, total: 4 },
            files: [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@' }]
        }, 'abcdef1234567890');
        expect(text).toContain('# Commit abcdef123456');
        expect(text).toContain('**Message**: fix: something');
        expect(text).toContain('`src/a.ts`');
        expect(text).toContain('```diff');
    });

    it('omits lockfile patches', () => {
        const text = renderCommit({
            sha: 'abc',
            message: 'chore: deps',
            files: [
                { filename: 'package-lock.json', patch: 'huge' },
                { filename: 'src/a.ts', patch: '@@ -1 +1 @@' }
            ]
        }, 'abc');
        expect(text).not.toContain('### `package-lock.json`');
        expect(text).toContain('Omitted 1 lockfile patch');
        expect(text).toContain('`src/a.ts`');
    });

    it('renders compare commits and files', () => {
        const text = renderCompare({
            base: 'v1',
            head: 'v2',
            commits: [{ sha: '1234567890', message: 'feat: x', author: 'Bob' }],
            files: [{ filename: 'a.ts', status: 'added', additions: 2, deletions: 0, patch: '+x' }]
        }, 'v1', 'v2');
        expect(text).toContain('# Compare v1...v2');
        expect(text).toContain('`1234567890`');
        expect(text).toContain('feat: x');
        expect(text).toContain('`a.ts`');
    });

    it('renders release body and assets', () => {
        const text = renderReleases([{
            tag: 'v2.0.0',
            name: 'Major',
            publishedAt: '2026-02-02',
            body: '## Breaking\n- removed x',
            assets: [{ name: 'a.tgz', url: 'https://example.com/a.tgz' }]
        }], 'v2.0.0');
        expect(text).toContain('# Releases: v2.0.0');
        expect(text).toContain('## Breaking');
        expect(text).toContain('[a.tgz](https://example.com/a.tgz)');
    });
});
