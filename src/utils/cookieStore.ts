import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 会话 Cookie 的磁盘持久化（best-effort）。
 *
 * 背景：百度等引擎在首次访问时由服务端种下长期标识 cookie（BAIDUID/BIDUPSID），
 * 内存态下 MCP 进程每次冷启动都要重新走一次首页预热。把**长期 cookie** 落盘复用，
 * 可省掉这次预热往返；只持久化长期项（短期会话 cookie 让服务端重新下发，
 * 否则拿过期会话反而更容易触发反爬）。
 *
 * 格式：wreq-js 的 cookie 对象数组（{name, value, domain, path, ...}）直接存 JSON。
 * 存储：~/.my-websearch/cookies.json（可用 MYWEBSEARCH_DATA_DIR 覆盖，测试用）
 */

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 百度长期 cookie 白名单（按 name 匹配） */
const BAIDU_LONG_LIVED_COOKIE_NAMES = new Set(['BAIDUID', 'BAIDUID_BFESS', 'BIDUPSID']);

/** wreq-js 的 cookie 形状（只需持久化用到的字段） */
export type WreqCookie = {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expiresAtMs?: number;
};

type StoredCookies = {
    cookies: WreqCookie[];
    savedAt: number;
};

type CookieStoreFile = {
    baidu?: StoredCookies;
};

function getDataDir(): string {
    return process.env.MYWEBSEARCH_DATA_DIR || path.join(os.homedir(), '.my-websearch');
}

function getStorePath(): string {
    return path.join(getDataDir(), 'cookies.json');
}

function getTtlMs(): number {
    const days = Number(process.env.MYWEBSEARCH_COOKIE_TTL_DAYS || '');
    return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : DEFAULT_TTL_MS;
}

function readStore(): CookieStoreFile {
    try {
        const raw = fs.readFileSync(getStorePath(), 'utf8');
        const parsed = JSON.parse(raw) as CookieStoreFile;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeStore(store: CookieStoreFile): void {
    try {
        const dir = getDataDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(getStorePath(), JSON.stringify(store, null, 2), 'utf8');
    } catch (error) {
        console.warn('Failed to persist cookies (best-effort, continuing):', error instanceof Error ? error.message : String(error));
    }
}

/** 把未知格式（WreqCookie 对象或遗留的 Netscape 格式制表符字符串）规范化为 WreqCookie */
export function normalizeWreqCookie(raw: unknown): WreqCookie | null {
    if (!raw) {
        return null;
    }
    if (typeof raw === 'object' && typeof (raw as WreqCookie).name === 'string' && typeof (raw as WreqCookie).value === 'string') {
        return raw as WreqCookie;
    }
    if (typeof raw === 'string') {
        const parts = raw.split('\t');
        if (parts.length >= 7) {
            const domain = parts[0];
            const path = parts[2];
            const secure = parts[3]?.toLowerCase() === 'true';
            const expiresSec = Number(parts[4]);
            const name = parts[5];
            const value = parts.slice(6).join('\t');
            if (name && value) {
                return {
                    name,
                    value,
                    domain,
                    path,
                    secure,
                    expiresAtMs: Number.isFinite(expiresSec) ? expiresSec * 1000 : undefined
                };
            }
        }
    }
    return null;
}

/** 筛出长期 cookie（按名称白名单，且要求必须为有效结构体） */
export function filterLongLivedBaiduCookies(cookies: unknown[]): WreqCookie[] {
    if (!Array.isArray(cookies)) {
        return [];
    }
    const normalized = cookies
        .map(normalizeWreqCookie)
        .filter((c): c is WreqCookie => c !== null);
    return normalized.filter((cookie) => cookie.name && BAIDU_LONG_LIVED_COOKIE_NAMES.has(cookie.name.toUpperCase()));
}

/** 读取持久化的百度长期 cookie（不存在/过期/无有效长期项时返回 null） */
export async function loadPersistedBaiduCookies(): Promise<WreqCookie[] | null> {
    const store = readStore();
    const entry = store.baidu;
    if (!entry || !Array.isArray(entry.cookies) || entry.cookies.length === 0) {
        return null;
    }
    if (Date.now() - entry.savedAt > getTtlMs()) {
        return null;
    }
    const validCookies = filterLongLivedBaiduCookies(entry.cookies);
    if (validCookies.length === 0) {
        return null;
    }
    return validCookies;
}

/** 持久化百度长期 cookie（best-effort；空数组不写盘） */
export async function savePersistedBaiduCookies(cookies: WreqCookie[]): Promise<void> {
    const longLived = filterLongLivedBaiduCookies(cookies);
    if (longLived.length === 0) {
        return;
    }
    const store = readStore();
    store.baidu = { cookies: longLived, savedAt: Date.now() };
    writeStore(store);
}
