import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    findChromeExecutable,
    buildChromeArgs,
    parseDevToolsActivePort,
    readDevToolsActivePort,
    killProcessTree,
    resetCachedBrowserPath
} from '../../utils/browser/chromeLauncher.js';
import { serializeCookieHeader } from '../../utils/browserCookies.js';
import { CDPSession, closeAllCDPSessions } from '../../utils/browser/cdpDriver.js';

describe('CDP Browser Driver & Chrome Launcher', () => {
    const tempDirsToCleanup: string[] = [];

    beforeEach(() => {
        resetCachedBrowserPath();
    });

    afterEach(() => {
        for (const dir of tempDirsToCleanup) {
            try {
                if (fs.existsSync(dir)) {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            } catch {
                // ignore
            }
        }
        tempDirsToCleanup.length = 0;
        resetCachedBrowserPath();
    });

    describe('1. Chrome Executable Discovery', () => {
        it('returns custom executable path when it exists', () => {
            const dummyExe = path.join(os.tmpdir(), `dummy-chrome-${Date.now()}.exe`);
            fs.writeFileSync(dummyExe, 'dummy', 'utf8');
            tempDirsToCleanup.push(dummyExe);

            const found = findChromeExecutable(dummyExe);
            expect(found).toBe(dummyExe);
        });

        it('respects CHROME_PATH or BROWSER_PATH environment variables', () => {
            const dummyExe = path.join(os.tmpdir(), `dummy-env-chrome-${Date.now()}.exe`);
            fs.writeFileSync(dummyExe, 'dummy', 'utf8');
            tempDirsToCleanup.push(dummyExe);

            const originalChromePath = process.env.CHROME_PATH;
            try {
                process.env.CHROME_PATH = dummyExe;
                resetCachedBrowserPath();
                const found = findChromeExecutable();
                expect(found).toBe(dummyExe);
            } finally {
                if (originalChromePath !== undefined) {
                    process.env.CHROME_PATH = originalChromePath;
                } else {
                    delete process.env.CHROME_PATH;
                }
            }
        });

        it('throws when no chromium executable is found', () => {
            const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
            try {
                resetCachedBrowserPath();
                expect(() => findChromeExecutable('/non/existent/path')).toThrow(
                    /No Chromium-based browser executable was found/
                );
            } finally {
                existsSpy.mockRestore();
            }
        });
    });

    describe('2. Chrome Arguments Construction', () => {
        const dummyDir = path.join(os.tmpdir(), 'test-cdp-profile');

        it('builds standard headless args by default', () => {
            const args = buildChromeArgs({}, dummyDir);
            expect(args).toContain('--headless=new');
            expect(args).toContain('--remote-debugging-port=0');
            expect(args).toContain(`--user-data-dir=${dummyDir}`);
            expect(args).toContain('--no-first-run');
            expect(args).toContain('--no-default-browser-check');
            expect(args).toContain('--remote-allow-origins=*');
            expect(args).not.toContain('--no-sandbox');
        });

        it('omits --headless=new when headless is explicitly false', () => {
            const args = buildChromeArgs({ headless: false }, dummyDir);
            expect(args).not.toContain('--headless=new');
            expect(args).toContain('--remote-debugging-port=0');
        });

        it('configures proxy server and bypass list', () => {
            const args = buildChromeArgs({
                proxy: {
                    server: 'http://127.0.0.1:7897',
                    bypass: '<local>;*.baidu.com'
                }
            }, dummyDir);

            expect(args).toContain('--proxy-server=http://127.0.0.1:7897');
            expect(args).toContain('--proxy-bypass-list=<local>;*.baidu.com');
        });

        it('adds --no-sandbox only when CHROME_NO_SANDBOX=true', () => {
            const originalNoSandbox = process.env.CHROME_NO_SANDBOX;
            try {
                process.env.CHROME_NO_SANDBOX = 'true';
                const args = buildChromeArgs({}, dummyDir);
                expect(args).toContain('--no-sandbox');
            } finally {
                if (originalNoSandbox !== undefined) {
                    process.env.CHROME_NO_SANDBOX = originalNoSandbox;
                } else {
                    delete process.env.CHROME_NO_SANDBOX;
                }
            }
        });

        it('merges extra custom args without duplicate --user-data-dir', () => {
            const args = buildChromeArgs({
                args: ['--custom-flag=1', `--user-data-dir=${dummyDir}`]
            }, dummyDir);

            expect(args).toContain('--custom-flag=1');
            const userDirArgs = args.filter((a) => a.startsWith('--user-data-dir='));
            expect(userDirArgs).toHaveLength(1);
        });
    });

    describe('3. DevToolsActivePort Parsing', () => {
        it('correctly parses valid port and wsPath', () => {
            const sample = '9222\n/devtools/browser/3b7b25e2-0fb3-4f93-bc8d-195b45c7da19\n';
            const parsed = parseDevToolsActivePort(sample);
            expect(parsed.port).toBe(9222);
            expect(parsed.wsPath).toBe('/devtools/browser/3b7b25e2-0fb3-4f93-bc8d-195b45c7da19');
        });

        it('handles Windows CRLF line endings', () => {
            const sample = '54321\r\n/devtools/browser/abc-123\r\n';
            const parsed = parseDevToolsActivePort(sample);
            expect(parsed.port).toBe(54321);
            expect(parsed.wsPath).toBe('/devtools/browser/abc-123');
        });

        it('throws on invalid port numbers', () => {
            expect(() => parseDevToolsActivePort('0\n/devtools/browser/abc\n')).toThrow(/Invalid DevTools port/);
            expect(() => parseDevToolsActivePort('-1\n/devtools/browser/abc\n')).toThrow(/Invalid DevTools port/);
            expect(() => parseDevToolsActivePort('99999\n/devtools/browser/abc\n')).toThrow(/Invalid DevTools port/);
            expect(() => parseDevToolsActivePort('abc\n/devtools/browser/abc\n')).toThrow(/Invalid DevTools port/);
        });

        it('throws on incomplete content', () => {
            expect(() => parseDevToolsActivePort('9222')).toThrow(/DevToolsActivePort content is invalid/);
            expect(() => parseDevToolsActivePort('')).toThrow(/DevToolsActivePort content is invalid/);
        });

        it('readDevToolsActivePort times out gracefully when file is absent', async () => {
            const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-port-dir-'));
            tempDirsToCleanup.push(emptyDir);

            await expect(readDevToolsActivePort(emptyDir, 150)).rejects.toThrow(/Timed out waiting for DevToolsActivePort/);
        });
    });

    describe('4. Cookie Serialization', () => {
        it('serializes cookies to standard HTTP header format', () => {
            const cookies = [
                { name: 'session_id', value: 'xyz123' },
                { name: 'token', value: 'abc-456' },
                { name: 'theme', value: 'dark' }
            ];
            const header = serializeCookieHeader(cookies);
            expect(header).toBe('session_id=xyz123; token=abc-456; theme=dark');
        });

        it('filters out empty or undefined cookies', () => {
            const cookies = [
                { name: 'valid', value: 'ok' },
                { name: '', value: 'missing-name' },
                { name: 'novalue', value: undefined as unknown as string }
            ];
            const header = serializeCookieHeader(cookies);
            expect(header).toBe('valid=ok');
        });
    });

    describe('5. Process Cleanup and Lifecycle', () => {
        it('killProcessTree ignores invalid PIDs safely', async () => {
            await expect(killProcessTree(0)).resolves.toBeUndefined();
            await expect(killProcessTree(-1)).resolves.toBeUndefined();
        });

        it('closeAllCDPSessions closes active sessions safely', async () => {
            const session = new CDPSession({ port: 9999 });
            await expect(closeAllCDPSessions()).resolves.toBeUndefined();
        });
    });
});
