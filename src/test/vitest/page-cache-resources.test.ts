import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PageCacheService } from '../../core/fetch/pageCache.js';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('PageCacheService resource APIs', () => {
    it('lists entries and reads them by opaque hash', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mws-page-cache-'));
        dirs.push(dir);
        const cache = new PageCacheService(dir);
        const record = cache.set('https://example.com/docs', 'x'.repeat(250), 'markdown', { title: 'Example docs' });
        expect(record).not.toBeNull();

        const listed = cache.list(5);
        expect(listed.length).toBe(1);
        expect(listed[0]?.normalizedUrl).toBe('https://example.com/docs');
        expect(cache.getByHash(record!.urlHash)?.title).toBe('Example docs');
        cache.close();
    });
});
