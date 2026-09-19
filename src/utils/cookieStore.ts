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
 * 存储：~/.my-websearch/cookies.json（可用 MYWEBSEARCH_DATA_DIR 覆盖，测试用）
 */

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 百度长期 cookie 白名单（Netcape 行格式的 cookie 名匹配） */
const BAIDU_LONG_LIVED_COOKIE_NAMES = new Set(['BAIDUID', 'BAIDUID_BFESS', 'BIDUPSID']);

type StoredCookies = {
    cookies: string[];
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

/** 从 Netscape 行格式的 cookie 中筛出长期项（按名称白名单） */
export function filterLongLivedBaiduCookies(cookies: string[]): string[] {
    return cookies.filter((line) => {
        // Netscape 格式：domain\tflag\tpath\tsecure\texpiry\tname\tvalue
        const parts = String(line).split('\t');
        const name = parts.length >= 6 ? parts[5].trim() : '';
        return name.length > 0 && BAIDU_LONG_LIVED_COOKIE_NAMES.has(name.toUpperCase());
    });
}

/** 读取持久化的百度长期 cookie（不存在/过期时返回 null） */
export async function loadPersistedBaiduCookies(): Promise<string[] | null> {
    const store = readStore();
    const entry = store.baidu;
    if (!entry || !Array.isArray(entry.cookies) || entry.cookies.length === 0) {
        return null;
    }
    if (Date.now() - entry.savedAt > getTtlMs()) {
        return null;
    }
    return entry.cookies;
}

/** 持久化百度长期 cookie（best-effort；空数组不写盘） */
export async function savePersistedBaiduCookies(cookies: string[]): Promise<void> {
    const longLived = filterLongLivedBaiduCookies(cookies);
    if (longLived.length === 0) {
        return;
    }
    const store = readStore();
    store.baidu = { cookies: longLived, savedAt: Date.now() };
    writeStore(store);
}
