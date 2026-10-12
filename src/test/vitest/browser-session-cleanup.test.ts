import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    removeTempDirInBackground,
    createForceKill,
    cleanOrphanTempProfilesInBackground,
    readBrowserDomainMetadataFromPath,
    BROWSER_METADATA_MAX_AGE_MS
} from '../../utils/playwright/browserSession.js';

function createDummyProfileDir(prefix: string, fileCount = 20): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const subDir = path.join(dir, 'Default', 'Cache');
    fs.mkdirSync(subDir, { recursive: true });

    for (let i = 0; i < fileCount; i++) {
        fs.writeFileSync(path.join(dir, `root_file_${i}.txt`), `dummy content ${i}`);
        fs.writeFileSync(path.join(subDir, `cache_file_${i}.bin`), Buffer.alloc(1024, i));
    }
    return dir;
}

async function waitForRemoval(targetPath: string, timeoutMs = 8000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (!fs.existsSync(targetPath)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !fs.existsSync(targetPath);
}

describe('browserSession background cleanup and non-blocking I/O', () => {
    const cleanupDirs: string[] = [];

    afterEach(() => {
        for (const dir of cleanupDirs) {
            try {
                if (fs.existsSync(dir)) {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            } catch {
                // ignore test cleanup errors
            }
        }
        cleanupDirs.length = 0;
    });

    it('removeTempDirInBackground should return immediately without blocking the event loop', async () => {
        const testDir = createDummyProfileDir('mcp-search-async-test-');
        cleanupDirs.push(testDir);

        const start = performance.now();
        // 传入 delayMs = 10，快速触发
        removeTempDirInBackground(testDir, 10);
        const duration = performance.now() - start;

        // 同步调用耗时必须在毫秒级（远低于同步 rmSync 删大量文件的几十秒阻塞）
        expect(duration).toBeLessThan(100);

        // 异步等待后台删除完成
        const removed = await waitForRemoval(testDir, 8000);
        expect(removed).toBe(true);
    });

    it('createForceKill should trigger non-blocking directory cleanup', async () => {
        const testDir = createDummyProfileDir('mcp-search-forcekill-test-');
        cleanupDirs.push(testDir);

        const forceKill = createForceKill(undefined, testDir);

        const start = performance.now();
        forceKill();
        const duration = performance.now() - start;

        // forceKill 调用必须立刻返回，不能同步阻塞
        expect(duration).toBeLessThan(100);

        // 异步等待后台清理完成
        const removed = await waitForRemoval(testDir, 8000);
        expect(removed).toBe(true);
    });

    it('cleanOrphanTempProfilesInBackground should sweep stale orphan profiles and preserve fresh ones', async () => {
        // 创建一个模拟过期的孤儿目录（>2小时前）
        const staleDir = createDummyProfileDir('mcp-search-orphan-stale-');
        cleanupDirs.push(staleDir);
        const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
        fs.utimesSync(staleDir, twoHoursAgo, twoHoursAgo);

        // 创建一个活跃/新生成的目录（当下生成）
        const freshDir = createDummyProfileDir('mcp-search-orphan-fresh-');
        cleanupDirs.push(freshDir);

        // 执行后台孤儿清理（阈值设为 1 小时）
        await cleanOrphanTempProfilesInBackground(60 * 60 * 1000);

        // 过期目录应被异步清理
        const staleRemoved = await waitForRemoval(staleDir, 8000);
        expect(staleRemoved).toBe(true);

        // 新目录应被保留
        expect(fs.existsSync(freshDir)).toBe(true);
    });

    it('readBrowserDomainMetadataFromPath preserves >12h profile when browser and client PIDs are still alive', () => {
        const profileDir = createDummyProfileDir('mcp-search-active-12h-', 2);
        cleanupDirs.push(profileDir);
        const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-search-meta-live-'));
        cleanupDirs.push(metaDir);
        const metadataPath = path.join(metaDir, 'browser-session-test.json');

        const expiredSavedAt = Date.now() - BROWSER_METADATA_MAX_AGE_MS - 60_000;
        fs.writeFileSync(
            metadataPath,
            JSON.stringify({
                endpoint: 'http://127.0.0.1:9222',
                tempDir: profileDir,
                browserPid: process.pid,
                clientPids: [process.pid],
                savedAt: expiredSavedAt
            }),
            'utf8'
        );

        const loaded = readBrowserDomainMetadataFromPath(metadataPath);
        expect(loaded).not.toBeNull();
        expect(loaded?.tempDir).toBe(profileDir);
        expect(loaded?.savedAt).toBeGreaterThan(expiredSavedAt);
        expect(fs.existsSync(profileDir)).toBe(true);
        expect(fs.existsSync(metadataPath)).toBe(true);
    });

    it('readBrowserDomainMetadataFromPath cleans up >12h profile when browser and client PIDs are dead', async () => {
        const profileDir = createDummyProfileDir('mcp-search-dead-12h-', 2);
        cleanupDirs.push(profileDir);
        const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-search-meta-dead-'));
        cleanupDirs.push(metaDir);
        const metadataPath = path.join(metaDir, 'browser-session-dead.json');

        const expiredSavedAt = Date.now() - BROWSER_METADATA_MAX_AGE_MS - 60_000;
        fs.writeFileSync(
            metadataPath,
            JSON.stringify({
                endpoint: 'http://127.0.0.1:9222',
                tempDir: profileDir,
                browserPid: 999999,
                clientPids: [999998],
                savedAt: expiredSavedAt
            }),
            'utf8'
        );

        const loaded = readBrowserDomainMetadataFromPath(metadataPath);
        expect(loaded).toBeNull();
        expect(fs.existsSync(metadataPath)).toBe(false);
        const removed = await waitForRemoval(profileDir, 8000);
        expect(removed).toBe(true);
    });
});

