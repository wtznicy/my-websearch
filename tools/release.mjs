#!/usr/bin/env node
/**
 * my-websearch 发版工具（gitee + GitHub 直连 API，不依赖任何 MCP server）
 *
 * 用法：
 *   node tools/release.mjs bump <版本号> [--dry-run]
 *   node tools/release.mjs release <版本号> --body <markdown 文件> [--target both|gitee|github] [--dry-run]
 *   node tools/release.mjs verify <版本号> [--json]
 *
 * Token 解析顺序（前一个没有就取下一个）：
 *   1. --tokens <file> 指定的 JSON 文件
 *   2. 环境变量 GITHUB_TOKEN / GH_TOKEN / GITEE_TOKEN
 *   3. 仓库根目录的 .release-tokens.json（已 gitignore），形如：
 *        { "github": "ghp_xxx", "gitee": "xxxx" }
 *
 * 只读/无副作用命令（verify、--dry-run）不需要 token。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'wtznicy';
const REPO = 'my-websearch';
const NPM_PACKAGE = 'my-websearch';
const REGISTRY_SERVER = 'io.github.wtznicy%2Fmy-websearch';

const TARGETS = ['both', 'gitee', 'github'];

// ── 输出helpers ────────────────────────────────────────────────────────────

const log = (msg) => console.log(msg);
const ok = (msg) => console.log(`✅ ${msg}`);
const warn = (msg) => console.warn(`⚠️  ${msg}`);
const fail = (msg) => {
    console.error(`❌ ${msg}`);
    process.exit(1);
};

// ── 参数解析 ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const name = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                flags[name] = next;
                i += 1;
            } else {
                flags[name] = true;
            }
            continue;
        }
        positional.push(arg);
    }
    return { positional, flags };
}

const parseVersion = (version) => {
    if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
        fail(`版本号不合法：${version ?? '(缺失)'}（应为 x.y.z 或 x.y.z-pre）`);
    }
    return version;
};

// ── 文件 helpers ───────────────────────────────────────────────────────────

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(
    path.join(ROOT, file),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8'
);

// ── token 解析 ─────────────────────────────────────────────────────────────

function resolveTokens(explicitFile) {
    const tokens = {};

    // 解析顺序：--tokens > 环境变量 > 仓库内文件 > 家目录私有文件
    // 推荐把 token 放在仓库之外（家目录），避免任何 AI 工具在仓库上下文里读到明文。
    const candidates = explicitFile
        ? [path.resolve(explicitFile)]
        : [
            path.join(ROOT, '.release-tokens.json'),
            path.join(os.homedir(), '.my-websearch', 'release-tokens.json')
        ];
    const filePath = candidates.find((candidate) => fs.existsSync(candidate));
    if (filePath) {
        try {
            const fromFile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (typeof fromFile.github === 'string') tokens.github = fromFile.github;
            if (typeof fromFile.gitee === 'string') tokens.gitee = fromFile.gitee;
        } catch (error) {
            warn(`${path.basename(filePath)} 解析失败：${error.message}`);
        }
    }

    // 环境变量优先级更高
    tokens.github = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || tokens.github;
    tokens.gitee = process.env.GITEE_TOKEN || tokens.gitee;

    return tokens;
}

const requireToken = (tokens, target) => {
    const token = tokens[target];
    if (token) {
        return token;
    }
    fail([
        `缺少 ${target} token。任选一种提供方式：`,
        `  - 环境变量：${target === 'github' ? 'GITHUB_TOKEN（或 GH_TOKEN）' : 'GITEE_TOKEN'}`,
        `  - 仓库根目录 .release-tokens.json：{"github":"...","gitee":"..."}（已 gitignore）`,
        `  - 参数：--tokens <文件路径>`
    ].join('\n'));
};

// ── git helpers ────────────────────────────────────────────────────────────

const git = (args) => execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    // 没网/没代理时 git ls-remote 会无限等待，且可能弹交互式认证提示
    timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
}).trim();

/** @returns {Promise<{state:'exists'}|{state:'missing'}|{state:'error',detail:string}>} */
async function remoteTagState(remote, version, tokens = {}) {
    try {
        const out = git(['ls-remote', '--tags', remote, `refs/tags/${version}`]);
        return out.length > 0 ? { state: 'exists' } : { state: 'missing' };
    } catch (error) {
        const detail = (error.killed || error.signal)
            ? `git ls-remote 超时（15s）`
            : String(error.message).split('\n')[0];

        // git 协议可能被网络掐断，但 API 往往仍然可用——用 API 复核一次再下结论
        if (remote === 'github' && tokens.github) {
            try {
                const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/ref/tags/${version}`, {
                    headers: { Authorization: `Bearer ${tokens.github}`, Accept: 'application/vnd.github+json', 'User-Agent': 'my-websearch-release-script' },
                    signal: AbortSignal.timeout(15000)
                });
                if (response.status === 200) {
                    warn(`git ls-remote 失败（${detail}），但 API 确认 tag 存在`);
                    return { state: 'exists' };
                }
                if (response.status === 404) {
                    return { state: 'missing' };
                }
            } catch {
                // 继续走 error 分支
            }
        }
        return { state: 'error', detail };
    }
}

/** 定位 Git 自带的 OpenSSL curl（仅 Windows 需要，用于绕开 Gitee WAF 对 schannel 的拒绝） */
function findGitCurl() {
    if (process.platform !== 'win32') {
        return null;
    }
    try {
        const gitPath = execFileSync('where', ['git.exe'], { encoding: 'utf8' }).split(/\r?\n/)[0];
        if (!gitPath) {
            return null;
        }
        // <git>/cmd/git.exe → <git>/mingw64/bin/curl.exe
        const candidate = path.join(path.dirname(path.dirname(path.dirname(gitPath))), 'mingw64', 'bin', 'curl.exe');
        return fs.existsSync(candidate) ? candidate : null;
    } catch {
        return null;
    }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function readJsonResponse(response) {
    const text = await response.text();
    try {
        return { body: JSON.parse(text), text };
    } catch {
        return { body: null, text };
    }
}

const isAlreadyExists = (status, body, text) => (
    status === 422 && /already_exists|already exists/i.test(text)
) || (status === 400 && /already exists|已经存在|已存在/i.test(text));

const giteeReleaseUrl = (version) => `https://gitee.com/${OWNER}/${REPO}/releases/tag/${version}`;

/** 查已存在的 Release 地址（幂等分支用；查不到就返回构造出来的页面地址） */
async function lookupReleaseUrl({ provider, version, token }) {
    if (provider === 'gitee') {
        return giteeReleaseUrl(version);
    }
    try {
        const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${version}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'my-websearch-release-script' },
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) {
            return undefined;
        }
        const json = await response.json();
        return json?.html_url ?? undefined;
    } catch {
        return undefined;
    }
}

// ── gitee release ──────────────────────────────────────────────────────────

async function createGiteeRelease({ version, body, token, dryRun }) {
    const payload = {
        access_token: token,
        tag_name: version,
        name: version,
        body,
        target_commitish: 'main'
    };
    const url = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}/releases`;

    if (dryRun) {
        log(`[dry-run] POST ${url}`);
        log(`[dry-run] tag_name=${version}, name=${version}, body=${body.length} 字符`);
        return { status: 'dry-run' };
    }

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000)
        });
    } catch (error) {
        // 只有**网络/TLS 层失败**才走 curl 兜底；明确的 HTTP 错误应当直接报出来
        warn(`gitee 直连失败（${error.cause?.code ?? error.message}），尝试 Git 自带 curl…`);
        return createGiteeReleaseViaCurl({ url, payload });
    }

    const { body: json, text } = await readJsonResponse(response);
    if (response.ok && json) {
        // gitee 的 release 响应里没有 html_url/url 字段，只能按约定拼页面地址
        return { status: 'created', url: giteeReleaseUrl(version) };
    }
    if (isAlreadyExists(response.status, json, text)) {
        return { status: 'exists', url: await lookupReleaseUrl({ provider: 'gitee', version, token }) };
    }
    fail(`gitee release 失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    return { status: 'failed' };
}

/** 兜底：用 Git 自带的 OpenSSL 版 curl 提交（Gitee 百度云 WAF 拒绝某些 TLS 栈时的既有解法） */
function createGiteeReleaseViaCurl({ url, payload }) {
    const curl = findGitCurl();
    if (!curl) {
        fail('gitee 直连失败，且找不到 Git 自带的 curl.exe 作为兜底。可在 Git Bash 里手动重试。');
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mws-release-'));
    const tmpFile = path.join(tmpDir, 'gitee-body.json');
    try {
        fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');
        const out = execFileSync(curl, ['-s', '-X', 'POST', url, '-H', 'Content-Type: application/json;charset=UTF-8', '-d', `@${tmpFile}`], { encoding: 'utf8' });
        const json = JSON.parse(out);
        if (json?.html_url) {
            return { status: 'created', url: json.html_url };
        }
        if (json?.id) {
            return { status: 'created', url: 'https://gitee.com/' + OWNER + '/' + REPO + '/releases/tag/' + payload.tag_name };
        }
        if (isAlreadyExists(200, json, out)) {
            return { status: 'exists' };
        }
        fail(`gitee curl 兜底也失败：${out.slice(0, 300)}`);
    } catch (error) {
        fail(`gitee curl 兜底失败：${error.message}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return { status: 'failed' };
}

// ── GitHub release ─────────────────────────────────────────────────────────

async function createGithubRelease({ version, body, token, dryRun }) {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/releases`;
    const payload = { tag_name: version, name: version, body, target_commitish: 'main' };

    if (dryRun) {
        log(`[dry-run] POST ${url}`);
        log(`[dry-run] tag_name=${version}, name=${version}, body=${body.length} 字符`);
        return { status: 'dry-run' };
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'my-websearch-release-script'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
    });
    const { body: json, text } = await readJsonResponse(response);

    if (response.ok && json) {
        return { status: 'created', url: json.html_url };
    }
    if (isAlreadyExists(response.status, json, text)) {
        return { status: 'exists', url: await lookupReleaseUrl({ provider: 'github', version, token }) };
    }
    fail(`GitHub release 失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    return { status: 'failed' };
}

// ── 子命令：bump ───────────────────────────────────────────────────────────

function commandBump({ positional, flags }) {
    const version = parseVersion(positional[1]);
    const dryRun = Boolean(flags['dry-run']);

    const pkg = readJson('package.json');
    const server = readJson('server.json');
    const current = pkg.version;
    if (version === current) {
        fail(`package.json 已经是 ${version}，无需 bump`);
    }

    log(`package.json : ${current} → ${version}`);
    log(`server.json  : ${server.version} → ${version}`);
    log(`server.json packages[0].version: ${server.packages?.[0]?.version} → ${version}`);

    if (dryRun) {
        ok('dry-run：未写入任何文件');
        return;
    }

    pkg.version = version;
    writeJson('package.json', pkg);
    server.version = version;
    if (server.packages?.[0]) {
        server.packages[0].version = version;
    }
    writeJson('server.json', server);
    ok(`已写入 package.json / server.json：${version}`);
    warn('下一步：git add -A && git commit，然后打 tag 并推两个远端');
}

// ── 子命令：release ────────────────────────────────────────────────────────

async function commandRelease({ positional, flags }) {
    const version = parseVersion(positional[1]);
    const target = String(flags.target ?? 'both');
    if (!TARGETS.includes(target)) {
        fail(`--target 只能是 ${TARGETS.join(' / ')}`);
    }

    const bodyFile = flags.body;
    // --body 是共享正文；两端可分别用 --body-gitee / --body-github 覆盖（gitee 中文、GitHub 英文的既有习惯）。
    // 因此 --body 只在「某个目标既没有专属 body 也没有共享 body」时才构成缺失。
    const bodyPath = typeof bodyFile === 'string' ? path.resolve(bodyFile) : null;
    if (bodyPath && !fs.existsSync(bodyPath)) {
        fail(`Release 说明文件不存在：${bodyPath}`);
    }
    const body = bodyPath ? fs.readFileSync(bodyPath, 'utf8').trim() : undefined;
    if (bodyPath && !body) {
        fail('Release 说明文件是空的');
    }

    // gitee 用中文、GitHub 用英文是既有习惯：允许 --body-gitee / --body-github 覆盖共享 body
    const readBodyIfAny = (flagValue, label) => {
        if (typeof flagValue !== 'string') {
            return undefined;
        }
        const target = path.resolve(flagValue);
        if (!fs.existsSync(target)) {
            fail(`${label} 指定的文件不存在：${target}`);
        }
        const text = fs.readFileSync(target, 'utf8').trim();
        if (!text) {
            fail(`${label} 指定的文件是空的`);
        }
        return text;
    };
    const bodyGitee = readBodyIfAny(flags['body-gitee'], '--body-gitee') ?? body;
    const bodyGithub = readBodyIfAny(flags['body-github'], '--body-github') ?? body;
    // 版本一致性铁律：三处必须与参数一致
    const pkg = readJson('package.json');
    const server = readJson('server.json');
    const mismatches = [];
    if (pkg.version !== version) mismatches.push(`package.json=${pkg.version}`);
    if (server.version !== version) mismatches.push(`server.json=${server.version}`);
    if (server.packages?.[0]?.version !== version) mismatches.push(`server.json packages[0]=${server.packages?.[0]?.version}`);
    if (mismatches.length > 0) {
        fail(`版本不一致（应为 ${version}）：${mismatches.join(', ')}。先跑 bump。`);
    }

    const tokens = resolveTokens(flags.tokens === true ? undefined : flags.tokens);
    const dryRun = Boolean(flags['dry-run']);
    const wantGitee = target === 'both' || target === 'gitee';
    const wantGithub = target === 'both' || target === 'github';

    if (wantGitee && !bodyGitee) {
        fail('缺少 gitee 发布说明：用 --body 或 --body-gitee 指定一个 markdown 文件');
    }
    if (wantGithub && !bodyGithub) {
        fail('缺少 GitHub 发布说明：用 --body 或 --body-github 指定一个 markdown 文件');
    }

    // tag 必须在位，否则 Release 指向不存在的提交
    const skipTagCheck = Boolean(flags['skip-tag-check']);
    for (const remote of [wantGitee ? 'gitee' : null, wantGithub ? 'github' : null].filter(Boolean)) {
        if (skipTagCheck) {
            warn(`--skip-tag-check：未校验 ${remote} 上的 tag ${version}`);
            continue;
        }
        const state = await remoteTagState(remote, version, tokens);
        if (state.state === 'missing') {
            fail(`${remote} 上没有 tag ${version}，先执行：git push ${remote} ${version}`);
        }
        if (state.state === 'error') {
            fail(`无法确认 ${remote} 上的 tag ${version}：${state.detail}\n若已确认推送成功，可加 --skip-tag-check 跳过校验`);
        }
    }

    const results = {};
    if (wantGitee) {
        results.gitee = await createGiteeRelease({
            version,
            body: bodyGitee,
            token: dryRun ? 'dry-run' : requireToken(tokens, 'gitee'),
            dryRun
        });
    }
    if (wantGithub) {
        results.github = await createGithubRelease({
            version,
            body: bodyGithub,
            token: dryRun ? 'dry-run' : requireToken(tokens, 'github'),
            dryRun
        });
    }

    log('');
    for (const [name, result] of Object.entries(results)) {
        const label = { created: '已创建', exists: '已存在（跳过）', 'dry-run': 'dry-run' }[result.status] ?? result.status;
        log(`${name.padEnd(7)} ${label}${result.url ? `  ${result.url}` : ''}`);
    }
    if (!dryRun) {
        warn('Release 说明中的敏感词会导致 gitee 自动把标题改成 release_<id>，正文用词需谨慎');
    }
}

// ── 子命令：verify ─────────────────────────────────────────────────────────

async function commandVerify({ positional, flags }) {
    const version = parseVersion(positional[1]);
    const rows = [];

    for (const remote of ['gitee', 'github']) {
        const state = await remoteTagState(remote, version, resolveTokens());
        const label = state.state === 'exists'
            ? '✅ 存在'
            : state.state === 'missing'
                ? '❌ 缺失'
                : `无法查询：${state.detail}`;
        rows.push([`git tag (${remote})`, label]);
    }

    try {
        const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, { headers: { Accept: 'application/json' } });
        const json = await response.json();
        rows.push(['npm latest', json?.version === version ? `✅ ${json.version}` : `❌ ${json?.version ?? '未知'}`]);
    } catch (error) {
        rows.push(['npm latest', `无法查询：${error.message}`]);
    }

    try {
        const response = await fetch(`https://registry.modelcontextprotocol.io/v0.1/servers/${REGISTRY_SERVER}/versions/${version}`, { headers: { Accept: 'application/json' } });
        rows.push(['MCP Registry', response.ok ? '✅ 已发布' : `❌ HTTP ${response.status}`]);
    } catch (error) {
        rows.push(['MCP Registry', `无法查询：${error.message}`]);
    }

    if (flags.json) {
        log(JSON.stringify(Object.fromEntries(rows), null, 2));
        return;
    }

    log(`版本 ${version} 发布状态：`);
    const width = Math.max(...rows.map(([name]) => name.length));
    for (const [name, status] of rows) {
        log(`  ${name.padEnd(width)}  ${status}`);
    }
}

// ── 入口 ───────────────────────────────────────────────────────────────────

const HELP = `my-websearch release tool

  node tools/release.mjs bump <版本号> [--dry-run]
      同步 package.json 与 server.json（含 packages[0].version）的版本号

  node tools/release.mjs release <版本号> --body <文件.md> [--body-gitee <zh.md>] [--body-github <en.md>] [--target both|gitee|github] [--dry-run] [--skip-tag-check]
      直连 gitee / GitHub API 创建 Release（幂等：已存在则跳过）
      tag 必须已经推到对应远端，否则直接报错（查询超时可用 --skip-tag-check 跳过）

  node tools/release.mjs verify <版本号> [--json]
      检查两个远端的 tag、npm latest、官方 MCP Registry 版本

Token（仅 release 需要）：
  环境变量 GITHUB_TOKEN / GH_TOKEN / GITEE_TOKEN，
  或仓库根目录 .release-tokens.json（已 gitignore），或 --tokens <文件>`;

async function main() {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const command = positional[0];

    switch (command) {
        case 'bump':
            commandBump({ positional, flags });
            return;
        case 'release':
            await commandRelease({ positional, flags });
            return;
        case 'verify':
            await commandVerify({ positional, flags });
            return;
        case 'help':
        case undefined:
            log(HELP);
            return;
        default:
            fail(`未知子命令：${command}\n\n${HELP}`);
    }
}

main().catch((error) => {
    console.error(`❌ ${error?.stack ?? error}`);
    process.exit(1);
});
