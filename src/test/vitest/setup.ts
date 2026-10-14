import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

// 默认在单元测试期间静默配置与常规日志，可通过 DEBUG_TEST_LOGS=true 恢复完整调试输出
if (process.env.DEBUG_TEST_LOGS !== 'true' && !process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = 'quiet';
}

// 隔离开发机上的真实用户配置（~/.my-websearch/config.json）。
// 配置自动加载会把用户的 PROXY_URL / USE_PROXY / API Key 注入 process.env，
// 污染依赖"未配置代理"等前置条件的断言——在 CI（无该文件）上绿、在开发机上红的假失败。
// 必须在任何测试模块 import 之前指向不存在的临时目录（见 configLoader.getAppConfigDir）。
if (!process.env.MYWEBSEARCH_DATA_DIR) {
    process.env.MYWEBSEARCH_DATA_DIR = path.join(os.tmpdir(), 'my-websearch-vitest-config-isolated');
}

afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
        const [{ config, formatSanitizedConfigSummary }, { getErrorClassificationMetrics }] = await Promise.all([
            import('../../config.js'),
            import('../../core/errors.js')
        ]);
        const summaryLines = formatSanitizedConfigSummary(config, process.env);
        const errorStats = getErrorClassificationMetrics();
        console.error(
            `\n[Test Failure Context] "${context.task.name}" failed. Sanitized runtime context:\n`
            + `${summaryLines.join('\n')}\n`
            + `ErrorClassificationMetrics: ${JSON.stringify(errorStats)}`
        );
    }
});
