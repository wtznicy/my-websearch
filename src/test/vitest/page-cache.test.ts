import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    PageCacheService,
    computeCacheKey,
    passesQualityGate,
    normalizeUrlForCache,
    determineTtlMs,
    DOC_PAGE_TTL_MS,
    DYNAMIC_PAGE_TTL_MS,
    NOT_FOUND_TTL_MS
} from '../../core/fetch/pageCache.js';

describe('Disk-level Markdown Page Cache', () => {
    let tempDir: string;
    let pageCache: PageCacheService;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-websearch-test-cache-'));
        pageCache = new PageCacheService(tempDir);
    });

    afterEach(() => {
        pageCache.close();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    it('computes deterministic cache keys for normalized URL and format', () => {
        const key1 = computeCacheKey('https://example.com/docs', 'markdown');
        const key2 = computeCacheKey('https://example.com/docs/', 'markdown');
        const keyWithParams = computeCacheKey('https://example.com/docs?utm_source=twitter&a=1&b=2', 'markdown');
        const keyReordered = computeCacheKey('https://example.com/docs?b=2&a=1', 'markdown');
        const keyText = computeCacheKey('https://example.com/docs', 'text');

        expect(key1).toBe(key2);
        expect(keyWithParams).toBe(keyReordered);
        expect(key1).not.toBe(keyText);
    });

    it('evaluates quality gate correctly', () => {
        // Passed: >= 200 chars, valid title, not bot challenge
        expect(passesQualityGate('A'.repeat(250), 'Sample Valid Title')).toBe(true);

        // Rejected: < 200 chars
        expect(passesQualityGate('Too short text', 'Sample Valid Title')).toBe(false);

        // Rejected: empty title
        expect(passesQualityGate('A'.repeat(250), '')).toBe(false);

        // Rejected: bot challenge
        expect(passesQualityGate('A'.repeat(250) + ' Just a moment... Cloudflare verification required', 'Just a moment...')).toBe(false);
    });

    it('determines TTL according to page type', () => {
        expect(determineTtlMs('https://docs.github.com/en/rest')).toBe(DOC_PAGE_TTL_MS);
        expect(determineTtlMs('https://developer.mozilla.org/en-US/docs/Web')).toBe(DOC_PAGE_TTL_MS);
        expect(determineTtlMs('https://news.ycombinator.com')).toBe(DYNAMIC_PAGE_TTL_MS);
        expect(determineTtlMs('https://example.com/non-existent', true)).toBe(NOT_FOUND_TTL_MS);
    });

    it('round-trips publishedAt through the cache', () => {
        const url = 'https://example.com/news/2024/10/21/story';
        const markdown = '# Story\n\n' + 'Body text that is long enough for the quality gate. '.repeat(10);
        pageCache.set(url, markdown, 'markdown', { title: 'Story', publishedAt: '2024-10-21' });

        const cached = pageCache.get(url, 'markdown');
        expect(cached?.publishedAt).toBe('2024-10-21');
    });

    it('caches and retrieves page entries with deep copy', () => {
        const url = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript';
        const markdown = '# JavaScript Documentation\n\n' + 'JavaScript is a high-level language. '.repeat(15);
        const title = 'JavaScript Documentation';

        const stored = pageCache.set(url, markdown, 'markdown', {
            title,
            etag: '"etag-123"',
            lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT'
        });

        expect(stored).not.toBeNull();

        const cached = pageCache.get(url, 'markdown');
        expect(cached).not.toBeNull();
        expect(cached?.title).toBe(title);
        expect(cached?.markdown).toBe(markdown);
        expect(cached?.etag).toBe('"etag-123"');

        // Verify deep copy: mutation of cached object should not affect next read
        if (cached) {
            cached.title = 'Mutated Title';
        }
        const cachedAgain = pageCache.get(url, 'markdown');
        expect(cachedAgain?.title).toBe('JavaScript Documentation');
    });

    it('supports negative caching for 404 responses', () => {
        const url = 'https://example.com/non-existent-page-404';
        const stored = pageCache.set(url, 'Not Found', 'markdown', {
            title: '404 Not Found',
            isNotFound: true
        });

        expect(stored).not.toBeNull();
        const cached = pageCache.get(url, 'markdown');
        expect(cached).not.toBeNull();
        expect(cached?.isNotFound).toBe(true);
    });
});
