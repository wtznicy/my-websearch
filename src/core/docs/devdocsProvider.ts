/**
 * DevDocs 官方离线/标准 API 文档检索器。
 *
 * 结构：
 * - 目录列表：https://devdocs.io/docs.json（800+ 语言与中间件，包含 Redis, Docker, Nginx, PostgreSQL, Python, C++, Go, Bash 等）
 * - 库索引表：https://documents.devdocs.io/<slug>/index.json（包含全部 API 条目、类型与相对路径）
 * - 条目正文：https://documents.devdocs.io/<slug>/<path>.html（纯净干净的 HTML 代码片段）
 */

import { requestDirectFirst, buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { htmlToMarkdown } from '../../utils/markdown.js';
import { logSafeError, logTool } from '../../tools/toolShared.js';

export interface DevDocsDoc {
    name: string;
    slug: string;
    type?: string;
    version?: string;
    release?: string;
    mtime?: number;
    db_size?: number;
}

export interface DevDocsEntry {
    name: string;
    path: string;
    type: string;
}

export interface DevDocsResult {
    source: 'devdocs';
    libraryId: string;
    documentationUrl: string;
    content: string;
    entryName: string;
    alternativeEntries?: string[];
}

const DEVDOCS_SLUG_ALIASES: Record<string, string> = {
    'postgres': 'postgresql~16',
    'postgresql': 'postgresql~16',
    'python': 'python~3.12',
    'python3': 'python~3.12',
    'c++': 'cpp',
    'k8s': 'kubernetes',
    'golang': 'go',
    'js': 'javascript',
    'ts': 'typescript',
    'node': 'node',
    'nodejs': 'node',
    'rust': 'rust',
    'ruby': 'ruby~3.3',
    'php': 'php',
    'html': 'html',
    'css': 'css',
    'vue': 'vue~3',
    'react': 'react'
};

const DOCS_LIST_URL = 'https://devdocs.io/docs.json';
const DOCUMENTS_BASE_URL = 'https://documents.devdocs.io';

let cachedDocsList: DevDocsDoc[] | null = null;
let cachedDocsListExpiresAt = 0;
const indexCache = new Map<string, { entries: DevDocsEntry[]; expiresAt: number }>();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时内存缓存

/** 获取并缓存 DevDocs 全部文档集列表 */
export async function fetchDevDocsCatalog(signal?: AbortSignal): Promise<DevDocsDoc[]> {
    const now = Date.now();
    if (cachedDocsList && cachedDocsListExpiresAt > now) {
        return cachedDocsList;
    }
    try {
        const res = await requestDirectFirst(
            'GET',
            DOCS_LIST_URL,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 5000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            'DevDocs docs catalog'
        );
        if (res.status === 200 && Array.isArray(res.data)) {
            cachedDocsList = res.data as DevDocsDoc[];
            cachedDocsListExpiresAt = now + CACHE_TTL_MS;
            return cachedDocsList;
        }
    } catch (err) {
        logSafeError('Failed to fetch DevDocs catalog', err);
    }
    return cachedDocsList ?? [];
}

/** 将用户传入的 library 转换为 DevDocs 的精确 slug */
export async function resolveDevDocsSlug(rawName: string, signal?: AbortSignal, version?: string): Promise<string | null> {
    const rawClean = rawName.trim().replace(/^devdocs?:/, '').trim().toLowerCase();
    let clean = rawClean;
    let reqVersion = version?.trim();
    if (clean.includes('@')) {
        const parts = clean.split('@');
        clean = parts[0]?.trim() || clean;
        if (!reqVersion && parts[1]) {
            reqVersion = parts[1].trim();
        }
    }
    if (!clean) return null;

    const catalog = await fetchDevDocsCatalog(signal);

    // 若指定了版本，优先匹配版本化 slug（如 python~3.11 或 angular~20）
    if (reqVersion) {
        const vClean = reqVersion.replace(/^v/, '').toLowerCase();
        const aliasTarget = DEVDOCS_SLUG_ALIASES[clean]?.split('~')[0] || clean;
        const versionedSlug = catalog.find((d) =>
            d.slug.toLowerCase() === `${clean}~${vClean}` ||
            d.slug.toLowerCase().startsWith(`${clean}~${vClean}`) ||
            d.slug.toLowerCase() === `${aliasTarget}~${vClean}` ||
            d.slug.toLowerCase().startsWith(`${aliasTarget}~${vClean}`)
        );
        if (versionedSlug) return versionedSlug.slug;
    }

    if (DEVDOCS_SLUG_ALIASES[clean]) {
        return DEVDOCS_SLUG_ALIASES[clean] ?? null;
    }

    if (catalog.length === 0) {
        return clean;
    }

    // 1. 精确匹配 slug
    const exactSlug = catalog.find((d) => d.slug.toLowerCase() === clean);
    if (exactSlug) return exactSlug.slug;

    // 2. 精确匹配 name
    const exactName = catalog.find((d) => d.name.toLowerCase() === clean);
    if (exactName) return exactName.slug;

    // 3. 前缀匹配（例如 redis 匹配 redis，angular 匹配 angular~21 中的无版本主条目）
    const prefixSlug = catalog.find((d) => d.slug.toLowerCase().startsWith(`${clean}~`));
    if (prefixSlug) return prefixSlug.slug;

    return null;
}

/** 获取特定文档集的索引条目 */
export async function fetchDevDocsIndex(slug: string, signal?: AbortSignal): Promise<DevDocsEntry[]> {
    const now = Date.now();
    const cached = indexCache.get(slug);
    if (cached && cached.expiresAt > now) {
        return cached.entries;
    }

    const indexUrl = `${DOCUMENTS_BASE_URL}/${encodeURIComponent(slug)}/index.json`;
    try {
        const res = await requestDirectFirst(
            'GET',
            indexUrl,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 10000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            `DevDocs index for ${slug}`
        );
        if (res.status === 200 && res.data && Array.isArray((res.data as { entries?: unknown[] }).entries)) {
            const entries = (res.data as { entries: DevDocsEntry[] }).entries;
            indexCache.set(slug, { entries, expiresAt: now + CACHE_TTL_MS });
            return entries;
        }
    } catch (err) {
        logSafeError(`Failed to fetch DevDocs index for ${slug}`, err);
    }
    return [];
}

/** 在条目中按 query 检索最佳条目 */
export function findMatchingDevDocsEntry(entries: DevDocsEntry[], query?: string): { match: DevDocsEntry | null; alternatives: string[] } {
    if (!entries || entries.length === 0) {
        return { match: null, alternatives: [] };
    }
    if (!query || !query.trim()) {
        const overview = entries.find((e) => e.path.endsWith('/index') || e.path === 'index' || e.name.toLowerCase() === 'overview') ?? entries[0] ?? null;
        return { match: overview, alternatives: [] };
    }

    const q = query.trim().toLowerCase();

    // 辅助单次查询匹配器
    const attemptMatch = (targetQuery: string): { match: DevDocsEntry | null; alternatives: string[] } | null => {
        // 1. 精确名称匹配
        const exact = entries.filter((e) => e.name.toLowerCase() === targetQuery);
        if (exact.length > 0) {
            const match = exact[0]!;
            const alts = entries.filter((e) => e !== match && e.name.toLowerCase().includes(targetQuery)).slice(0, 5).map((e) => e.name);
            return { match, alternatives: alts };
        }

        // 2. 前缀名称匹配
        const prefix = entries.filter((e) => e.name.toLowerCase().startsWith(targetQuery));
        if (prefix.length > 0) {
            const match = prefix[0]!;
            const alts = prefix.slice(1, 6).map((e) => e.name);
            return { match, alternatives: alts };
        }

        // 3. 包含名称或分类匹配
        const substr = entries.filter((e) => e.name.toLowerCase().includes(targetQuery) || (e.type && e.type.toLowerCase().includes(targetQuery)));
        if (substr.length > 0) {
            const match = substr[0]!;
            const alts = substr.slice(1, 6).map((e) => e.name);
            return { match, alternatives: alts };
        }

        // 4. path 匹配
        const pathMatch = entries.filter((e) => e.path.toLowerCase().includes(targetQuery));
        if (pathMatch.length > 0) {
            const match = pathMatch[0]!;
            const alts = pathMatch.slice(1, 6).map((e) => e.name);
            return { match, alternatives: alts };
        }

        return null;
    };

    // 1. 优先尝试原始 query
    const directResult = attemptMatch(q);
    if (directResult) {
        return directResult;
    }

    // 2. 若原始 query 未命中（例如传了 "redis/hset"、"redis.hset"、"redis:hset"、"redis hset"），
    // 智能剥离前置库名/命名空间前缀，提取末尾 symbol（如 "hset"）进行二次匹配
    const delimiters = ['/', '.', ':', ' '];
    for (const d of delimiters) {
        if (q.includes(d)) {
            const token = q.split(d).filter(Boolean).pop()?.trim();
            if (token && token !== q) {
                const subResult = attemptMatch(token);
                if (subResult) {
                    return subResult;
                }
            }
        }
    }

    return { match: null, alternatives: entries.slice(0, 5).map((e) => e.name) };
}

/** 核心查询入口：根据库名与关键词检索 DevDocs */
export async function queryDevDocs(options: {
    library: string;
    version?: string;
    query?: string;
    signal?: AbortSignal;
}): Promise<DevDocsResult | null> {
    let rawLib = options.library.trim().replace(/^devdocs?:/, '').trim();
    let effectiveQuery = options.query?.trim();

    // 若 library 包含斜杠（例如 "redis/hset"），DevDocs slug 均不含斜杠，自动将首段作为 library，其余作为 query
    if (rawLib.includes('/')) {
        const slashIdx = rawLib.indexOf('/');
        const potentialLib = rawLib.slice(0, slashIdx).trim();
        const potentialQ = rawLib.slice(slashIdx + 1).trim();
        if (potentialLib) {
            rawLib = potentialLib;
            if (!effectiveQuery && potentialQ) {
                effectiveQuery = potentialQ;
            }
        }
    }

    const slug = await resolveDevDocsSlug(rawLib, options.signal, options.version);
    if (!slug) return null;

    logTool(`DevDocs resolved slug "${slug}" for "${rawLib}"`);
    const entries = await fetchDevDocsIndex(slug, options.signal);
    if (entries.length === 0) return null;

    const { match, alternatives } = findMatchingDevDocsEntry(entries, effectiveQuery);
    if (!match) return null;

    const rawPath = match.path.split('#')[0] || match.path;
    const cleanPath = rawPath.endsWith('.html') ? rawPath : `${rawPath}.html`;
    const htmlUrl = `${DOCUMENTS_BASE_URL}/${encodeURIComponent(slug)}/${cleanPath}`;
    try {
        const res = await requestDirectFirst(
            'GET',
            htmlUrl,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 10000,
                responseType: 'text',
                signal: options.signal,
                forceDirect
            }),
            `DevDocs entry ${slug}/${rawPath}`
        );

        if (res.status === 200 && typeof res.data === 'string' && res.data.trim().length > 20) {
            const markdown = htmlToMarkdown(res.data);
            if (markdown && markdown.trim().length > 10) {
                return {
                    source: 'devdocs',
                    libraryId: slug,
                    entryName: match.name,
                    documentationUrl: `https://devdocs.io/${slug}/${match.path}`,
                    content: markdown,
                    alternativeEntries: alternatives.length > 0 ? alternatives : undefined
                };
            }
        }
    } catch (err) {
        logSafeError(`Failed to fetch DevDocs entry HTML for ${htmlUrl}`, err);
    }

    return null;
}
