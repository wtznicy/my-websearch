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
