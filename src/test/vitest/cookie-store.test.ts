import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    filterLongLivedBaiduCookies,
    loadPersistedBaiduCookies,
    savePersistedBaiduCookies
} from '../../utils/cookieStore.js';

// wreq-js 的 cookie 对象格式
const LONG_LIVED = [
    { name: 'BAIDUID', value: 'ABC123:FG=1', domain: '.baidu.com', path: '/', secure: true },
    { name: 'BIDUPSID', value: 'DEF456', domain: '.baidu.com', path: '/', secure: true }
];
const SHORT_LIVED = [
    { name: 'BDSVRTM', value: '7', domain: '.baidu.com', path: '/' },
    { name: 'H_PS_PSSID', value: '1234_5678', domain: '.baidu.com', path: '/' }
];

let tempDir: string;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mywebsearch-cookie-test-'));
    process.env.MYWEBSEARCH_DATA_DIR = tempDir;
});

afterEach(() => {
    delete process.env.MYWEBSEARCH_DATA_DIR;
    delete process.env.MYWEBSEARCH_COOKIE_TTL_DAYS;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('filterLongLivedBaiduCookies', () => {
    it('should keep only whitelisted long-lived cookies', () => {
        const filtered = filterLongLivedBaiduCookies([...LONG_LIVED, ...SHORT_LIVED]);
        expect(filtered).toHaveLength(2);
        expect(filtered.map((cookie) => cookie.name).join(',')).toBe('BAIDUID,BIDUPSID');
    });
});

describe('cookie persistence', () => {
    it('should round-trip long-lived cookies through disk', async () => {
        await savePersistedBaiduCookies([...LONG_LIVED, ...SHORT_LIVED]);
        const loaded = await loadPersistedBaiduCookies();
        expect(loaded).toHaveLength(2);
        expect(loaded![0].name).toBe('BAIDUID');
        expect(loaded![0].value).toBe('ABC123:FG=1');
    });

    it('should return null when nothing persisted', async () => {
        expect(await loadPersistedBaiduCookies()).toBeNull();
    });

    it('should not persist when no long-lived cookies present', async () => {
        await savePersistedBaiduCookies(SHORT_LIVED);
        expect(await loadPersistedBaiduCookies()).toBeNull();
    });

    it('should expire entries after TTL', async () => {
        await savePersistedBaiduCookies(LONG_LIVED);
        // TTL 设为极小值（1 天 = 86400000ms > 0；通过回写过期时间模拟）
        const storePath = path.join(tempDir, 'cookies.json');
        const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        store.baidu.savedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 天前
        fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');
        expect(await loadPersistedBaiduCookies()).toBeNull();
    });

    it('should correctly parse legacy Netscape string cookies from disk and convert to WreqCookie', async () => {
        const storePath = path.join(tempDir, 'cookies.json');
        const legacyStore = {
            baidu: {
                cookies: [
                    '.baidu.com\tTRUE\t/\tFALSE\t1824365820\tBIDUPSID\t2FD7E49C17E421FE37CF0DDD3FC47B7F',
                    '.baidu.com\tTRUE\t/\tFALSE\t1821341832\tBAIDUID\t2FD7E49C17E421FE37CF0DDD3FC47B7F:FG=1',
                    '.baidu.com\tTRUE\t/\tTRUE\t1821341832\tBAIDUID_BFESS\t2FD7E49C17E421FE37CF0DDD3FC47B7F:FG=1'
                ],
                savedAt: Date.now()
            }
        };
        fs.writeFileSync(storePath, JSON.stringify(legacyStore), 'utf8');
        const loaded = await loadPersistedBaiduCookies();
        expect(loaded).not.toBeNull();
        expect(loaded).toHaveLength(3);
        expect(loaded![0]).toMatchObject({
            name: 'BIDUPSID',
            value: '2FD7E49C17E421FE37CF0DDD3FC47B7F',
            domain: '.baidu.com'
        });
        expect(loaded![1]).toMatchObject({
            name: 'BAIDUID',
            value: '2FD7E49C17E421FE37CF0DDD3FC47B7F:FG=1',
            domain: '.baidu.com'
        });
    });
});

describe('hasBaiduSessionCookie（注入不变量校验）', () => {
    it('会话里没有 BAIDUID 系 cookie 时必须判为需要预热', async () => {
        const { hasBaiduSessionCookie } = await import('../../engines/baidu/impersonate.js');

        // 2026-09 故障：磁盘返回 3 条但注入全失败 → 会话为空，却因 length>0 跳过预热
        expect(hasBaiduSessionCookie([])).toBe(false);
        expect(hasBaiduSessionCookie([{ name: 'BIDUPSID' }, { name: 'BD_HOME' }])).toBe(false);
        expect(hasBaiduSessionCookie([{ name: undefined }, {} as { name?: string }])).toBe(false);
    });

    it('会话里存在 BAIDUID / BAIDUID_BFESS 时判为无需预热', async () => {
        const { hasBaiduSessionCookie } = await import('../../engines/baidu/impersonate.js');

        expect(hasBaiduSessionCookie([{ name: 'BAIDUID' }])).toBe(true);
        expect(hasBaiduSessionCookie([{ name: 'BIDUPSID' }, { name: 'BAIDUID_BFESS' }])).toBe(true);
    });
});
