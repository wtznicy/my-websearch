import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { looksLikeBotChallengePage } from '../antiBot/antiBotDetection.js';

export interface PageCacheRecord {
    urlHash: string;
    normalizedUrl: string;
    format: string;
    markdown: string;
    title: string;
    etag?: string;
    lastModified?: string;
    fetchedAt: number;
    expiresAt: number;
    contentHash: string;
    totalLength: number;
    byteSize: number;
    isNotFound?: boolean;
    siteName?: string;
    isPdf?: boolean;
    pdfPages?: number;
}

export interface SetPageCacheOptions {
    etag?: string;
    lastModified?: string;
    title?: string;
    siteName?: string;
    isNotFound?: boolean;
    isPdf?: boolean;
    pdfPages?: number;
    ttlMs?: number;
}

export const DYNAMIC_PAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const DOC_PAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const NOT_FOUND_TTL_MS = 60 * 1000; // 60 seconds
export const MAX_CACHE_BYTES = 200 * 1024 * 1024; // 200 MB LRU limit
export const MIN_CONTENT_CHARS_FOR_CACHE = 200;

const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'spm', 'from', 'ref', 'source', 'fbclid', 'gclid', '_hsenc', '_hsmi',
    'mc_cid', 'mc_eid', 'igshid', 'yclid'
]);

export function normalizeUrlForCache(rawUrl: string): string {
    try {
        const u = new URL(rawUrl);
        u.hash = '';
        u.hostname = u.hostname.toLowerCase();
        u.protocol = u.protocol.toLowerCase();

        // Strip default ports
        if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
            u.port = '';
        }

        // Clean tracking params and sort
        const params = new URLSearchParams(u.search);
        const keysToDelete: string[] = [];
        for (const key of params.keys()) {
            if (TRACKING_PARAMS.has(key.toLowerCase()) || key.startsWith('utm_')) {
                keysToDelete.push(key);
            }
        }
        for (const key of keysToDelete) {
            params.delete(key);
        }
        params.sort();
        u.search = params.toString() ? `?${params.toString()}` : '';

        // Normalize trailing slash (keep root slash)
        let pathname = u.pathname;
        if (pathname.length > 1 && pathname.endsWith('/')) {
            pathname = pathname.slice(0, -1);
        }
        u.pathname = pathname;

        return u.toString();
    } catch {
        return rawUrl.trim();
    }
}

export function computeCacheKey(rawUrl: string, format = 'markdown'): string {
    const normalized = normalizeUrlForCache(rawUrl);
    return crypto.createHash('sha256').update(`${normalized}:${format.toLowerCase()}`).digest('hex');
}

export function isDocumentationUrl(rawUrl: string): boolean {
    try {
        const u = new URL(rawUrl);
        const host = u.hostname.toLowerCase();
        const p = u.pathname.toLowerCase();

        if (host.startsWith('docs.') || host.startsWith('developer.') || host.startsWith('wiki.')) {
            return true;
        }
        if (host.endsWith('github.io') || host.endsWith('readthedocs.io') || host.endsWith('gitbook.io')) {
            return true;
        }
        if (/\/(docs|documentation|guide|manual|reference|api-doc|api-docs|tutorials?)\b/i.test(p)) {
            return true;
        }
        if (host === 'github.com' && /^\/[^/]+\/[^/]+(?:\/tree\/[^/]+|\/blob\/[^/]+)?(?:\/README\.md)?$/i.test(p)) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

export function determineTtlMs(rawUrl: string, isNotFound = false): number {
    if (isNotFound) {
        return NOT_FOUND_TTL_MS;
    }
    return isDocumentationUrl(rawUrl) ? DOC_PAGE_TTL_MS : DYNAMIC_PAGE_TTL_MS;
}

export function passesQualityGate(markdown: string, title?: string): boolean {
    if (!title || !title.trim()) {
        return false;
    }
    if (markdown.length < MIN_CONTENT_CHARS_FOR_CACHE) {
        return false;
    }
    if (looksLikeBotChallengePage(markdown)) {
        return false;
    }
    return true;
}

export function getDefaultPageCacheDir(): string {
    if (process.env.MY_WEBSEARCH_CACHE_DIR) {
        return path.resolve(process.env.MY_WEBSEARCH_CACHE_DIR);
    }
    const base = process.env.LOCALAPPDATA
        || (process.platform === 'darwin'
            ? path.join(os.homedir(), 'Library', 'Caches')
            : path.join(os.homedir(), '.cache'));
    return path.join(base, 'my-websearch', 'pages');
}

function safeSetPermissions(targetPath: string, mode: number): void {
    try {
        fs.chmodSync(targetPath, mode);
    } catch {
        // Ignored on platforms (e.g. standard Windows ACL) where chmod is no-op
    }
}

interface StorageBackend {
    get(key: string): PageCacheRecord | null;
    set(record: PageCacheRecord): void;
    renewTtl(key: string, newExpiresAt: number): void;
    delete(key: string): void;
    clear(): void;
    close(): void;
}

class SqliteStorageBackend implements StorageBackend {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private db: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stmtGet: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stmtSet: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stmtTouch: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stmtRenew: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stmtDel: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stmtClear: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stmtTotalBytes: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stmtLruPrune: any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(DatabaseSync: any, dbPath: string) {
        const dir = path.dirname(dbPath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        safeSetPermissions(dir, 0o700);

        this.db = new DatabaseSync(dbPath);
        safeSetPermissions(dbPath, 0o600);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS page_cache (
                url_hash TEXT PRIMARY KEY,
                normalized_url TEXT NOT NULL,
                format TEXT NOT NULL,
                markdown TEXT NOT NULL,
                title TEXT NOT NULL,
                etag TEXT,
                last_modified TEXT,
                fetched_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                content_hash TEXT NOT NULL,
                total_length INTEGER NOT NULL,
                byte_size INTEGER NOT NULL,
                is_not_found INTEGER NOT NULL DEFAULT 0,
                site_name TEXT,
                is_pdf INTEGER NOT NULL DEFAULT 0,
                pdf_pages INTEGER,
                last_accessed_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_page_cache_lru ON page_cache (last_accessed_at ASC);
            CREATE INDEX IF NOT EXISTS idx_page_cache_expires ON page_cache (expires_at ASC);
        `);

        this.stmtGet = this.db.prepare('SELECT * FROM page_cache WHERE url_hash = ?');
        this.stmtTouch = this.db.prepare('UPDATE page_cache SET last_accessed_at = ? WHERE url_hash = ?');
        this.stmtSet = this.db.prepare(`
            INSERT OR REPLACE INTO page_cache (
                url_hash, normalized_url, format, markdown, title,
                etag, last_modified, fetched_at, expires_at, content_hash,
                total_length, byte_size, is_not_found, site_name, is_pdf, pdf_pages, last_accessed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.stmtRenew = this.db.prepare('UPDATE page_cache SET expires_at = ?, fetched_at = ?, last_accessed_at = ? WHERE url_hash = ?');
        this.stmtDel = this.db.prepare('DELETE FROM page_cache WHERE url_hash = ?');
        this.stmtClear = this.db.prepare('DELETE FROM page_cache');
        this.stmtTotalBytes = this.db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS total FROM page_cache');
        this.stmtLruPrune = this.db.prepare('SELECT url_hash, byte_size FROM page_cache ORDER BY last_accessed_at ASC LIMIT 50');
    }

    get(key: string): PageCacheRecord | null {
        const row = this.stmtGet.get(key);
        if (!row) {
            return null;
        }
        const now = Date.now();
        this.stmtTouch.run(now, key);

        return {
            urlHash: row.url_hash,
            normalizedUrl: row.normalized_url,
            format: row.format,
            markdown: row.markdown,
            title: row.title,
            etag: row.etag || undefined,
            lastModified: row.last_modified || undefined,
            fetchedAt: row.fetched_at,
            expiresAt: row.expires_at,
            contentHash: row.content_hash,
            totalLength: row.total_length,
            byteSize: row.byte_size,
            isNotFound: Boolean(row.is_not_found),
            siteName: row.site_name || undefined,
            isPdf: Boolean(row.is_pdf),
            pdfPages: row.pdf_pages || undefined
        };
    }

    set(record: PageCacheRecord): void {
        const now = Date.now();
        this.stmtSet.run(
            record.urlHash,
            record.normalizedUrl,
            record.format,
            record.markdown,
            record.title,
            record.etag ?? null,
            record.lastModified ?? null,
            record.fetchedAt,
            record.expiresAt,
            record.contentHash,
            record.totalLength,
            record.byteSize,
            record.isNotFound ? 1 : 0,
            record.siteName ?? null,
            record.isPdf ? 1 : 0,
            record.pdfPages ?? null,
            now
        );
        this.pruneLru();
    }

    renewTtl(key: string, newExpiresAt: number): void {
        const now = Date.now();
        this.stmtRenew.run(newExpiresAt, now, now, key);
    }

    delete(key: string): void {
        this.stmtDel.run(key);
    }

    clear(): void {
        this.stmtClear.run();
    }

    close(): void {
        try {
            this.db.close();
        } catch {
            // best-effort
        }
    }

    private pruneLru(): void {
        try {
            let total = this.stmtTotalBytes.get()?.total ?? 0;
            while (total > MAX_CACHE_BYTES) {
                const candidates = this.stmtLruPrune.all();
                if (!candidates || candidates.length === 0) {
                    break;
                }
                for (const row of candidates) {
                    this.stmtDel.run(row.url_hash);
                    total -= row.byte_size;
                    if (total <= MAX_CACHE_BYTES) {
                        break;
                    }
                }
            }
        } catch {
            // best-effort LRU prune
        }
    }
}

class JsonFileStorageBackend implements StorageBackend {
    private dir: string;
    private memoryIndex = new Map<string, { byteSize: number; lastAccessedAt: number }>();

    constructor(cacheDir: string) {
        this.dir = cacheDir;
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        safeSetPermissions(this.dir, 0o700);
        this.initIndex();
    }

    private initIndex(): void {
        try {
            const files = fs.readdirSync(this.dir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const key = file.replace(/\.json$/, '');
                    const filePath = path.join(this.dir, file);
                    try {
                        const stat = fs.statSync(filePath);
                        this.memoryIndex.set(key, {
                            byteSize: stat.size,
                            lastAccessedAt: stat.mtimeMs
                        });
                    } catch {
                        // ignore broken entry
                    }
                }
            }
        } catch {
            // ignore
        }
    }

    private getFilePath(key: string): string {
        return path.join(this.dir, `${key}.json`);
    }

    get(key: string): PageCacheRecord | null {
        const filePath = this.getFilePath(key);
        if (!fs.existsSync(filePath)) {
            this.memoryIndex.delete(key);
            return null;
        }
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const record = JSON.parse(data) as PageCacheRecord;
            const now = Date.now();
            this.memoryIndex.set(key, {
                byteSize: data.length,
                lastAccessedAt: now
            });
            return record;
        } catch {
            this.delete(key);
            return null;
        }
    }

    set(record: PageCacheRecord): void {
        const filePath = this.getFilePath(record.urlHash);
        const data = JSON.stringify(record);
        try {
            fs.writeFileSync(filePath, data, { mode: 0o600, encoding: 'utf8' });
            safeSetPermissions(filePath, 0o600);
            this.memoryIndex.set(record.urlHash, {
                byteSize: Buffer.byteLength(data, 'utf8'),
                lastAccessedAt: Date.now()
            });
            this.pruneLru();
        } catch {
            // write failed (e.g. disk full)
        }
    }

    renewTtl(key: string, newExpiresAt: number): void {
        const record = this.get(key);
        if (record) {
            record.expiresAt = newExpiresAt;
            record.fetchedAt = Date.now();
            this.set(record);
        }
    }

    delete(key: string): void {
        this.memoryIndex.delete(key);
        const filePath = this.getFilePath(key);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch {
            // best-effort
        }
    }

    clear(): void {
        this.memoryIndex.clear();
        try {
            const files = fs.readdirSync(this.dir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        fs.unlinkSync(path.join(this.dir, file));
                    } catch {
                        // ignore
                    }
                }
            }
        } catch {
            // ignore
        }
    }

    close(): void {
        this.memoryIndex.clear();
    }

    private pruneLru(): void {
        let total = 0;
        for (const meta of this.memoryIndex.values()) {
            total += meta.byteSize;
        }
        if (total <= MAX_CACHE_BYTES) {
            return;
        }

        const sorted = Array.from(this.memoryIndex.entries()).sort(
            (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
        );

        for (const [key, meta] of sorted) {
            this.delete(key);
            total -= meta.byteSize;
            if (total <= MAX_CACHE_BYTES) {
                break;
            }
        }
    }
}

export class PageCacheService {
    private backend: StorageBackend;
    private cacheDir: string;

    constructor(customCacheDir?: string) {
        this.cacheDir = customCacheDir || getDefaultPageCacheDir();

        let initializedBackend: StorageBackend | null = null;
        try {
            // Try loading node:sqlite (native in Node 22+)
            const { DatabaseSync } = require('node:sqlite');
            if (typeof DatabaseSync === 'function') {
                const dbPath = path.join(this.cacheDir, 'pages.db');
                initializedBackend = new SqliteStorageBackend(DatabaseSync, dbPath);
            }
        } catch {
            initializedBackend = null;
        }

        if (!initializedBackend) {
            initializedBackend = new JsonFileStorageBackend(this.cacheDir);
        }
        this.backend = initializedBackend;
    }

    public get(rawUrl: string, format = 'markdown'): PageCacheRecord | null {
        const key = computeCacheKey(rawUrl, format);
        const record = this.backend.get(key);
        if (!record) {
            return null;
        }

        // Deep clone on read to prevent cache pollution
        return structuredClone(record);
    }

    public isExpired(record: PageCacheRecord): boolean {
        return Date.now() >= record.expiresAt;
    }

    public set(
        rawUrl: string,
        markdown: string,
        format = 'markdown',
        options: SetPageCacheOptions = {}
    ): PageCacheRecord | null {
        const normalizedUrl = normalizeUrlForCache(rawUrl);
        const key = computeCacheKey(rawUrl, format);
        const title = options.title?.trim() || '';

        // Quality gate check (skip for 404 negative cache)
        if (!options.isNotFound && !passesQualityGate(markdown, title)) {
            return null;
        }

        const now = Date.now();
        const ttlMs = options.ttlMs ?? determineTtlMs(rawUrl, options.isNotFound);
        const expiresAt = now + ttlMs;
        const contentHash = crypto.createHash('sha256').update(markdown).digest('hex');
        const byteSize = Buffer.byteLength(markdown, 'utf8');

        const record: PageCacheRecord = {
            urlHash: key,
            normalizedUrl,
            format: format.toLowerCase(),
            markdown,
            title,
            etag: options.etag,
            lastModified: options.lastModified,
            fetchedAt: now,
            expiresAt,
            contentHash,
            totalLength: markdown.length,
            byteSize,
            isNotFound: options.isNotFound,
            siteName: options.siteName,
            isPdf: options.isPdf,
            pdfPages: options.pdfPages
        };

        // Deep clone before storing
        this.backend.set(structuredClone(record));
        return structuredClone(record);
    }

    public renew(rawUrl: string, format = 'markdown', newTtlMs?: number): void {
        const key = computeCacheKey(rawUrl, format);
        const effectiveTtl = newTtlMs ?? determineTtlMs(rawUrl, false);
        this.backend.renewTtl(key, Date.now() + effectiveTtl);
    }

    public delete(rawUrl: string, format = 'markdown'): void {
        const key = computeCacheKey(rawUrl, format);
        this.backend.delete(key);
    }

    public clear(): void {
        this.backend.clear();
    }

    public close(): void {
        this.backend.close();
    }
}

let globalPageCacheInstance: PageCacheService | null = null;

export function getGlobalPageCache(): PageCacheService {
    if (!globalPageCacheInstance) {
        globalPageCacheInstance = new PageCacheService();
    }
    return globalPageCacheInstance;
}

export function __setGlobalPageCacheForTests(cache: PageCacheService | null): void {
    if (globalPageCacheInstance && globalPageCacheInstance !== cache) {
        globalPageCacheInstance.close();
    }
    globalPageCacheInstance = cache;
}
