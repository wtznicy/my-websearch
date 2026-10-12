import { afterEach } from 'vitest';

// 默认在单元测试期间静默配置与常规日志，可通过 DEBUG_TEST_LOGS=true 恢复完整调试输出
if (process.env.DEBUG_TEST_LOGS !== 'true' && !process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = 'quiet';
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
