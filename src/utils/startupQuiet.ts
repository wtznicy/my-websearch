/**
 * 启动日志静默前置模块。
 *
 * 必须在 build/index.js 的【第一个 import】位置加载：index.js 的静态依赖链
 * （playwrightClient → config 等）会在 main() 执行前就求值 config.js 并打印
 * 启动配置日志，那时再设置 env 已经太晚。ESM 按 import 声明顺序深度优先求值，
 * 因此本模块先于所有其他依赖执行，可以提前把 OPEN_WEBSEARCH_QUIET_STARTUP 设好。
 */
const argv = process.argv.slice(2);
const [command] = argv;
const isQuietInvocation =
    // 无参数 = MCP 兼容入口：Claude Desktop / Cherry Studio 以 stdio 裸启动，
    // 约 10 行启动配置日志只会变成 stderr 噪音，默认静默（诊断时可设 LOG_LEVEL=normal）
    argv.length === 0
    || command === '--help' || command === '-h' || command === 'help' || command === 'status'
    || argv.includes('--json')
    || (process.env.LOG_LEVEL ?? '').toLowerCase() === 'quiet';

if (isQuietInvocation) {
    process.env.OPEN_WEBSEARCH_QUIET_STARTUP = 'true';
}

/**
 * Windows 旧控制台（GBK 代码页 936）下 emoji 会乱码（如 🌐 → 馃Л）。
 * 在最早加载的模块里探测代码页，非 UTF-8 时把 console 输出的常见 emoji
 * 替换为 ASCII 标签，保证日志可读。
 */
if (process.platform === 'win32' && process.env.OPEN_WEBSEARCH_NO_EMOJI !== 'true') {
    let isGbkConsole = false;
    try {
        // 延迟 require 避免引入额外依赖；chcp 无参数时输出 "活动代码页: 936"
        const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
        const chcpOutput = execFileSync('chcp', { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).toString();
        const codePage = Number(/\d+/.exec(chcpOutput)?.[0]);
        isGbkConsole = Number.isFinite(codePage) && codePage !== 65001;
    } catch {
        // 探测失败（无 chcp/无控制台）不处理
    }

    if (isGbkConsole) {
        const EMOJI_TO_ASCII: Record<string, string> = {
            '🔎': '[search]', '🧭': '[playwright]', '🌐': '[proxy]', '🔐': '[tls]',
            '🖥️': '[server]', '🔒': '[cors]', '⚠️': '[warn]', '✅': '[ok]',
            '❌': '[fail]', '🚀': '[start]', '🔌': '[transport]', '📝': '[log]',
            '🔍': '[find]', '💾': '[save]'
        };
        const replaceEmojis = (args: unknown[]): unknown[] => args.map((arg) =>
            typeof arg === 'string' ? arg.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, (emoji) => EMOJI_TO_ASCII[emoji] ?? '?') : arg
        );
        for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
            const original = console[method].bind(console);
            (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (...args: unknown[]) => original(...replaceEmojis(args));
        }
    }
}
