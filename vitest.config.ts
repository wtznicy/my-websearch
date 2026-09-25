import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // 新测试文件放在 src/test/vitest/ 目录下，使用 describe/it/expect
        include: ['src/test/vitest/**/*.test.ts'],
        // 冷启动（首次编译 + 首次 import 原生可选依赖）在慢机器上可能远超 vitest 默认的 5s，
        // 会造成"首次跑挂、重跑就过"的假失败（测评报告 P2-14 观察到的现象）
        testTimeout: 60000,
        hookTimeout: 60000,
        // 覆盖率配置（可选，后续启用）
        // coverage: {
        //     include: ['src/**'],
        //     exclude: ['src/test/**'],
        //     reporter: ['text', 'json-summary'],
        // },
    },
});
