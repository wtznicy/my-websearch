import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // 新测试文件放在 src/test/vitest/ 目录下，使用 describe/it/expect
        include: ['src/test/vitest/**/*.test.ts'],
        // 覆盖率配置（可选，后续启用）
        // coverage: {
        //     include: ['src/**'],
        //     exclude: ['src/test/**'],
        //     reporter: ['text', 'json-summary'],
        // },
    },
});
