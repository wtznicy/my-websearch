import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * queryDocs 的独立结果缓存（与 fetchWebContent 的 URL 页面缓存分开）。
 *
 * - 默认 24h TTL：文档更新频率低，重复问答没必要反复打 Context7。
 * - 优先使用 Node 22 内置 `node:sqlite`；不可用时退回 JSON 文件。
 * - 只缓存成功且置信度 >= medium 的结果（由调用方保证）。
 */

export const DOCS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

export interface DocsCacheValue {
    text: string;
    source: string;
    confidence: 'high' | 'medium';
    cachedAt: number;
}

type SqliteDatabase = {
    exec(sql: string): void;
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
        run(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
    };
};

let sqliteDb: SqliteDatabase | null | undefined;
let jsonLoaded = false;
const jsonEntries = new Map<string, DocsCacheValue & { expiresAt: number }>();

function cacheDir(): string {
    return join(homedir(), '.my-websearch', 'cache');
}

function sqlitePath(): string {
    return join(cacheDir(), 'query-docs.sqlite');
}

function jsonPath(): string {
    return join(cacheDir(), 'query-docs.json');
}

function ensureDir(): void {
    const dir = cacheDir();
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function openSqlite(): SqliteDatabase | null {
    if (sqliteDb !== undefined) {
        return sqliteDb;
    }
    try {
        ensureDir();
        const require = createRequire(import.meta.url);
        const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };
        const db = new DatabaseSync(sqlitePath());
        db.exec(`
            CREATE TABLE IF NOT EXISTS query_docs_cache (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_query_docs_expires ON query_docs_cache(expires_at);
        `);
        sqliteDb = db;
        return db;
    } catch {
        sqliteDb = null;
        return null;
    }
}

function loadJson(): void {
    if (jsonLoaded) {
        return;
    }
    jsonLoaded = true;
    try {
        if (!existsSync(jsonPath())) {
            return;
        }
        const raw = JSON.parse(readFileSync(jsonPath(), 'utf-8')) as Record<string, DocsCacheValue & { expiresAt: number }>;
        for (const [key, value] of Object.entries(raw)) {
            if (value && typeof value.expiresAt === 'number') {
                jsonEntries.set(key, value);
            }
        }
    } catch {
        // 损坏的缓存文件不影响查询
    }
}

function persistJson(): void {
    try {
        ensureDir();
        const now = Date.now();
        for (const [key, value] of jsonEntries) {
            if (value.expiresAt <= now) {
                jsonEntries.delete(key);
            }
        }
        // 简单 LRU：超出上限时删最旧的 cachedAt
        if (jsonEntries.size > MAX_ENTRIES) {
            const sorted = [...jsonEntries.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
            for (const [key] of sorted.slice(0, jsonEntries.size - MAX_ENTRIES)) {
                jsonEntries.delete(key);
            }
        }
        const target = jsonPath();
        const tmp = `${target}.tmp`;
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(jsonEntries)), 'utf-8');
        renameSync(tmp, target);
    } catch {
        // 缓存写失败不影响主流程
    }
}

export function getDocsCache(key: string): DocsCacheValue | null {
    const now = Date.now();
    const db = openSqlite();
    if (db) {
        try {
            const row = db.prepare('SELECT value, expires_at FROM query_docs_cache WHERE key = ?').get(key) as
                | { value?: string; expires_at?: number }
                | undefined;
            if (!row?.value || typeof row.expires_at !== 'number' || row.expires_at <= now) {
                return null;
            }
            return JSON.parse(row.value) as DocsCacheValue;
        } catch {
            return null;
        }
    }
    loadJson();
    const entry = jsonEntries.get(key);
    if (!entry || entry.expiresAt <= now) {
        jsonEntries.delete(key);
        return null;
    }
    return { text: entry.text, source: entry.source, confidence: entry.confidence, cachedAt: entry.cachedAt };
}

export function setDocsCache(key: string, value: DocsCacheValue): void {
    const expiresAt = Date.now() + DOCS_CACHE_TTL_MS;
    const db = openSqlite();
    if (db) {
        try {
            db.prepare(
                'INSERT OR REPLACE INTO query_docs_cache (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)'
            ).run(key, JSON.stringify(value), expiresAt, value.cachedAt);
            db.prepare('DELETE FROM query_docs_cache WHERE expires_at <= ?').run(Date.now());
            db.prepare(
                'DELETE FROM query_docs_cache WHERE key NOT IN (SELECT key FROM query_docs_cache ORDER BY created_at DESC LIMIT ?)'
            ).run(MAX_ENTRIES);
            return;
        } catch {
            // fall through to JSON
        }
    }
    loadJson();
    jsonEntries.set(key, { ...value, expiresAt });
    persistJson();
}

/** 测试或诊断用：清空两种后端 */
export function clearDocsCache(): void {
    jsonEntries.clear();
    jsonLoaded = false;
    const db = openSqlite();
    if (db) {
        try {
            db.exec('DELETE FROM query_docs_cache');
        } catch {
            // ignore
        }
    }
    try {
        if (existsSync(jsonPath())) {
            writeFileSync(jsonPath(), '{}', 'utf-8');
        }
    } catch {
        // ignore
    }
}

export function docsCacheKey(parts: {
    library: string;
    version?: string;
    query?: string;
    limit?: number;
    strict?: boolean;
}): string {
    return [
        // v2：修复裸库名解析（tailwindcss → 官方 tailwindlabs）后，旧缓存必须失效
        'v2',
        parts.library.trim().toLowerCase(),
        parts.version?.trim() ?? '',
        parts.query?.trim().toLowerCase() ?? '',
        String(parts.limit ?? 5),
        parts.strict ? 'strict' : 'loose'
    ].join('|');
}
