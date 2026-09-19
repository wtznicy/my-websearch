import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    filterLongLivedBaiduCookies,
    loadPersistedBaiduCookies,
    savePersistedBaiduCookies
} from '../../utils/cookieStore.js';

// Netscape 行格式：domain\tflag\tpath\tsecure\texpiry\tname\tvalue
const LONG_LIVED = [
    '.baidu.com\tTRUE\t/\tFALSE\t1900000000\tBAIDUID\tABC123:FG=1',
    '.baidu.com\tTRUE\t/\tFALSE\t1900000000\tBIDUPSID\tDEF456'
];
const SHORT_LIVED = [
    '.baidu.com\tTRUE\t/\tFALSE\t0\tBDSVRTM\t7',
    '.baidu.com\tTRUE\t/\tFALSE\t0\tH_PS_PSSID\t1234_5678'
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
        expect(filtered.join('\n')).toContain('BAIDUID');
        expect(filtered.join('\n')).toContain('BIDUPSID');
        expect(filtered.join('\n')).not.toContain('BDSVRTM');
    });
});

describe('cookie persistence', () => {
    it('should round-trip long-lived cookies through disk', async () => {
        await savePersistedBaiduCookies([...LONG_LIVED, ...SHORT_LIVED]);
        const loaded = await loadPersistedBaiduCookies();
        expect(loaded).toHaveLength(2);
        expect(loaded!.join('\n')).toContain('BAIDUID');
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
});
