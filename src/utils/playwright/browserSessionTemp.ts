import { rm as rmAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
/**
 * 校验临时目录是否安全位于系统临时目录下，且符合 mcp-search- 前缀，
 * 防止元数据篡改导致的任意目录递归删除安全风险。
 */
export function isSafeTempDir(tempDir: string | undefined): boolean {
    if (!tempDir || typeof tempDir !== 'string') {
        return false;
    }
    const resolved = path.resolve(tempDir);
    const osTmp = path.resolve(tmpdir());
    const relative = path.relative(osTmp, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return false;
    }
    const baseName = path.basename(resolved);
    return baseName.startsWith('mcp-search-');
}

/**
 * [P0 修复与增强] 异步删除浏览器 profile 临时目录。
 *
 * 背景：Chrome profile 目录含 Cache/LevelDB 等数千至数万个小文件，
 * 同步 rmSync(recursive) 会阻塞 Node 主事件循环——实测单个僵尸会话清理阻塞 52.9 秒
 * （空目录同期仅 78ms），期间整个 MCP server 冻结，所有并发请求连坐超时，且 JS 层预算定时器失效。
 *
 * 增强防御：
 * 1. 采用 fs/promises.rm 异步删除，避免主线程事件循环冻结。
 * 2. Windows 下进程 taskkill 后可能在毫秒级内仍持有文件句柄（如 LOCK/Cookies），
 *    立即删除容易触发 EBUSY/EPERM 导致删除失败残留（导致 %TEMP% 积累上 GB 孤儿目录）。
 *    因此配置 maxRetries: 5, retryDelay: 300，并在延时后执行，确保锁释放并成功清理。
 * 3. 严格校验 tempDir 路径必须为系统临时目录下的 mcp-search-* 目录。
 */
export function removeTempDirInBackground(tempDir: string | undefined, delayMs = 300): void {
    if (!tempDir || !isSafeTempDir(tempDir)) {
        return;
    }
    const execute = () => {
        void rmAsync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
    };
    if (delayMs > 0) {
        const timer = setTimeout(execute, delayMs);
        if (typeof timer === 'object' && 'unref' in timer) {
            timer.unref();
        }
    } else {
        execute();
    }
}
