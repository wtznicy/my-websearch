import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleInitCommand, parseInitArgs } from '../../cli/commands/init.js';
import {
    buildLaunchCommand,
    buildServerEntry,
    CLIENT_TARGETS,
    findNpxBinary,
    parseClientIds,
    type InitHost
} from '../../cli/init/clientTargets.js';
import {
    applyPatch,
    findExistingServerKey,
    planPatch,
    readConfigDocument
} from '../../cli/init/patcher.js';
import type { MyWebSearchRuntime } from '../../runtime/runtimeTypes.js';

const mockRuntime = { config: {} } as unknown as MyWebSearchRuntime;

const tempDirs: string[] = [];

const makeTempDir = (prefix = 'mws-init-'): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
};

const makeHost = (overrides: Partial<InitHost> = {}): InitHost => ({
    home: path.join(path.sep, 'home', 'tester'),
    cwd: path.join(path.sep, 'work', 'project'),
    platform: process.platform,
    env: { ...process.env },
    ...overrides
});

const makeIo = () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        stdout,
        stderr,
        io: {
            stdout: (text: string) => { stdout.push(text); },
            stderr: (text: string) => { stderr.push(text); }
        }
    };
};

const runInit = async (argv: string[]) => {
    const { stdout, stderr, io } = makeIo();
    const exitCode = await handleInitCommand({
        argv,
        io,
        runtime: mockRuntime,
        options: {}
    });
    return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
};

const readJson = (filePath: string): Record<string, unknown> => (
    JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
);

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('init client targets', () => {
    const targetById = (id: string) => CLIENT_TARGETS.find((target) => target.id === id);

    it('resolves Claude Desktop config paths per platform', () => {
        const winHost = makeHost({ platform: 'win32', env: { APPDATA: path.join('C:', 'Users', 'a', 'AppData', 'Roaming') } });
        expect(targetById('claude-desktop')?.configPath(winHost))
            .toBe(path.join('C:', 'Users', 'a', 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'));

        const macHost = makeHost({ platform: 'darwin' });
        expect(targetById('claude-desktop')?.configPath(macHost))
            .toBe(path.join(macHost.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));

        const linuxHost = makeHost({ platform: 'linux' });
        expect(targetById('claude-desktop')?.configPath(linuxHost))
            .toBe(path.join(linuxHost.home, '.config', 'Claude', 'claude_desktop_config.json'));
    });

    it('resolves Cursor and workspace-scoped VS Code paths', () => {
        const host = makeHost();
        expect(targetById('cursor')?.configPath(host)).toBe(path.join(host.home, '.cursor', 'mcp.json'));
        expect(targetById('vscode')?.configPath(host)).toBe(path.join(host.cwd, '.vscode', 'mcp.json'));
    });

    it('uses mcpServers for Claude/Cursor and top-level servers for VS Code', () => {
        expect(targetById('claude-desktop')?.shape).toBe('mcpServers');
        expect(targetById('cursor')?.shape).toBe('mcpServers');
        expect(targetById('vscode')?.shape).toBe('servers');
    });
});

describe('init launch command', () => {
    it('wraps npx in cmd /c on Windows', () => {
        const host = makeHost({ platform: 'win32' });
        const launch = buildLaunchCommand(host, process.execPath);
        expect(launch.command).toBe('cmd');
        expect(launch.args.slice(0, 2)).toEqual(['/c', 'npx']);
        expect(launch.args).toContain('my-websearch@latest');
    });

    it('uses plain npx on POSIX so node version upgrades do not break the config', () => {
        const host = makeHost({ platform: 'linux' });
        const launch = buildLaunchCommand(host, process.execPath);
        expect(launch.command).toBe('npx');
        expect(launch.args).toEqual(['-y', 'my-websearch@latest']);
    });

    it('warns when npx cannot be found on this machine', () => {
        const host = makeHost({ platform: 'linux', env: { PATH: '' } });
        const launch = buildLaunchCommand(host, path.join(path.sep, 'definitely', 'missing', 'node'));
        expect(launch.warning).toBeTruthy();
    });

    it('finds npx through PATH', () => {
        const dir = makeTempDir('mws-npx-');
        const binary = path.join(dir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
        fs.writeFileSync(binary, '', 'utf8');
        const host = makeHost({ env: { PATH: dir } });
        expect(findNpxBinary(host, path.join(path.sep, 'missing', 'node'))).toBe(binary);
    });

    it('builds the server entry with stdio mode', () => {
        const entry = buildServerEntry({ command: 'npx', args: ['-y', 'my-websearch@latest'] });
        expect(entry).toEqual({
            command: 'npx',
            args: ['-y', 'my-websearch@latest'],
            env: { MODE: 'stdio' }
        });
    });
});

describe('parseClientIds', () => {
    it('accepts aliases and the all keyword', () => {
        expect(parseClientIds('claude')).toEqual(['claude-desktop']);
        expect(parseClientIds('code')).toEqual(['vscode']);
        expect(parseClientIds('cursor,code')).toEqual(['cursor', 'vscode']);
        expect(parseClientIds('all')).toEqual(['claude-desktop', 'cursor', 'vscode']);
    });

    it('rejects unknown clients', () => {
        expect(() => parseClientIds('vim')).toThrow(/Unknown client "vim"/);
    });
});

describe('parseInitArgs', () => {
    it('parses flags and client lists', () => {
        const parsed = parseInitArgs(['--dry-run', '--force', '--json', '--client', 'cursor']);
        expect(parsed.dryRun).toBe(true);
        expect(parsed.force).toBe(true);
        expect(parsed.json).toBe(true);
        expect(parsed.clients).toEqual(['cursor']);
        expect(parsed.clientsExplicit).toBe(true);
    });

    it('supports inline --client= and --home=', () => {
        const parsed = parseInitArgs(['--client=cursor,vscode', '--home=tmproot']);
        expect(parsed.clients).toEqual(['cursor', 'vscode']);
        expect(parsed.home).toBe(path.resolve('tmproot'));
    });

    it('rejects unknown flags and stray positionals', () => {
        expect(() => parseInitArgs(['--nope'])).toThrow(/Unknown flag/);
        expect(() => parseInitArgs(['stray'])).toThrow(/Unexpected argument/);
    });
});

describe('patcher', () => {
    let dir: string;
    let configPath: string;
    const entry = { command: 'npx', args: ['-y', 'my-websearch@latest'], env: { MODE: 'stdio' } };

    beforeEach(() => {
        dir = makeTempDir();
        configPath = path.join(dir, 'nested', 'mcp.json');
    });

    it('treats a missing file as an empty document', () => {
        expect(readConfigDocument(configPath)).toEqual({ raw: null, data: {} });
    });

    it('refuses to modify invalid JSON or non-object roots', () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{ not json', 'utf8');
        expect(() => readConfigDocument(configPath)).toThrow(/not valid JSON/);
        fs.writeFileSync(configPath, '[1,2,3]', 'utf8');
        expect(() => readConfigDocument(configPath)).toThrow(/expected a JSON object/);
    });

    it('creates the entry and the parent directory on first write', () => {
        const plan = planPatch({ configPath, shape: 'mcpServers', entry, force: false });
        expect(plan.action).toBe('create');
        expect(plan.nextRaw).toContain('my-websearch');

        const applied = applyPatch(plan);
        expect(applied.written).toBe(true);
        expect(applied.backupPath).toBeNull();
        expect(readJson(configPath)).toEqual({ mcpServers: { 'my-websearch': entry } });
    });

    it('reports unchanged on a second identical run', () => {
        applyPatch(planPatch({ configPath, shape: 'mcpServers', entry, force: false }));
        const again = planPatch({ configPath, shape: 'mcpServers', entry, force: false });
        expect(again.action).toBe('unchanged');
        expect(again.nextRaw).toBeNull();
    });

    it('detects legacy alias keys and migrates them to the canonical name with --force', () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const legacyEntry = { command: 'npx', args: ['-y', 'open-websearch@latest'] };
        fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { 'open-websearch': legacyEntry }, theme: 'dark' }), 'utf8');

        expect(findExistingServerKey(readConfigDocument(configPath).data, 'mcpServers')).toBe('open-websearch');

        const skipped = planPatch({ configPath, shape: 'mcpServers', entry, force: false });
        expect(skipped.action).toBe('conflict');
        expect(skipped.nextRaw).toBeNull();
        expect(applyPatch(skipped).written).toBe(false);

        const forced = planPatch({ configPath, shape: 'mcpServers', entry, force: true });
        expect(forced.action).toBe('update');
        const applied = applyPatch(forced);
        expect(applied.written).toBe(true);
        expect(applied.backupPath).toBeTruthy();

        const written = readJson(configPath);
        expect(written.theme).toBe('dark');
        expect(Object.keys(written.mcpServers as Record<string, unknown>)).toEqual(['my-websearch']);
        expect(fs.readFileSync(applied.backupPath as string, 'utf8')).toContain('open-websearch');
    });

    it('preserves unrelated keys and existing servers', () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcpServers: { other: { command: 'foo' } },
            globalShortcut: 'Ctrl+Space'
        }), 'utf8');

        applyPatch(planPatch({ configPath, shape: 'mcpServers', entry, force: false }));
        const written = readJson(configPath);
        expect(written.globalShortcut).toBe('Ctrl+Space');
        expect((written.mcpServers as Record<string, unknown>).other).toEqual({ command: 'foo' });
        expect((written.mcpServers as Record<string, unknown>)['my-websearch']).toEqual(entry);
    });

    it('tolerates a UTF-8 BOM', () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, `\uFEFF${JSON.stringify({ mcpServers: {} })}`, 'utf8');
        expect(readConfigDocument(configPath).data).toEqual({ mcpServers: {} });
    });
});

describe('init command handler', () => {
    it('does not force full runtime initialization', async () => {
        const { commandNeedsRuntime } = await import('../../cli/runCli.js');
        // init 只碰配置文件；一旦被加进 COMMANDS_REQUIRING_RUNTIME，
        // 它会白白初始化 Playwright/引擎状态，启动慢且可能拉浏览器。
        expect(commandNeedsRuntime(['init'])).toBe(false);
    });

    it('writes the Cursor config and reports created', async () => {
        const home = makeTempDir();
        const { exitCode, stdout } = await runInit(['--client', 'cursor', '--home', home]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('created');

        const written = readJson(path.join(home, '.cursor', 'mcp.json'));
        const servers = written.mcpServers as Record<string, Record<string, unknown>>;
        expect(servers['my-websearch']?.env).toEqual({ MODE: 'stdio' });
    });

    it('is idempotent across repeated runs', async () => {
        const home = makeTempDir();
        await runInit(['--client', 'cursor', '--home', home]);
        const { exitCode, stdout } = await runInit(['--client', 'cursor', '--home', home]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('already up to date');
    });

    it('--dry-run prints the plan but writes nothing', async () => {
        const home = makeTempDir();
        const { exitCode, stdout } = await runInit(['--client', 'cursor', '--home', home, '--dry-run']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('Dry run');
        expect(fs.existsSync(path.join(home, '.cursor', 'mcp.json'))).toBe(false);
    });

    it('--json returns a machine-readable envelope', async () => {
        const home = makeTempDir();
        const { exitCode, stdout } = await runInit(['--client', 'cursor', '--home', home, '--json']);
        expect(exitCode).toBe(0);
        const envelope = JSON.parse(stdout) as {
            status: string;
            data: { summary: { written: number }; targets: Array<{ id: string; status: string }> };
        };
        expect(envelope.status).toBe('ok');
        expect(envelope.data.summary.written).toBe(1);
        expect(envelope.data.targets[0]?.id).toBe('cursor');
        expect(envelope.data.targets[0]?.status).toBe('create');
    });

    it('leaves a corrupt config untouched and exits 1', async () => {
        const home = makeTempDir();
        const configPath = path.join(home, '.cursor', 'mcp.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{ broken', 'utf8');

        const { exitCode, stdout } = await runInit(['--client', 'cursor', '--home', home]);
        expect(exitCode).toBe(1);
        expect(stdout).toContain('not valid JSON');
        expect(fs.readFileSync(configPath, 'utf8')).toBe('{ broken');
    });

    it('does not overwrite a differing existing entry without --force', async () => {
        const home = makeTempDir();
        const configPath = path.join(home, '.cursor', 'mcp.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const original = JSON.stringify({ mcpServers: { 'my-websearch': { command: 'old' } } });
        fs.writeFileSync(configPath, original, 'utf8');

        const { exitCode, stdout } = await runInit(['--client', 'cursor', '--home', home]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('existing entry differs');
        expect(stdout).toContain('--force');
        expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    });

    it('writes top-level "servers" for VS Code workspaces', async () => {
        const home = makeTempDir();
        const originalCwd = process.cwd();
        try {
            process.chdir(home);
            const { exitCode } = await runInit(['--client', 'vscode']);
            expect(exitCode).toBe(0);
            const written = readJson(path.join(home, '.vscode', 'mcp.json'));
            expect(written.mcpServers).toBeUndefined();
            expect(Object.keys(written.servers as Record<string, unknown>)).toEqual(['my-websearch']);
        } finally {
            process.chdir(originalCwd);
        }
    });

    it('reports not-detected and prints paste-ready snippets when nothing is installed', async () => {
        const home = makeTempDir();
        const originalCwd = process.cwd();
        // 防止自动探测命中开发机上真实的 Claude Desktop 配置目录
        const originalAppData = process.env.APPDATA;
        try {
            process.chdir(home);
            process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
            const { exitCode, stdout } = await runInit(['--home', home]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain('No supported client was detected');
            expect(stdout).toContain('Claude Desktop');
            expect(stdout).toContain('mcpServers');
        } finally {
            process.chdir(originalCwd);
            if (originalAppData === undefined) {
                delete process.env.APPDATA;
            } else {
                process.env.APPDATA = originalAppData;
            }
        }
    });
});
