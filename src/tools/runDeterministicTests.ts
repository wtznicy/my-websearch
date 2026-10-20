import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 运行 `src/test/test-*.ts` 里**确定性**的脚本（不联网、不需要 Playwright）。
 *
 * 背景：这些脚本是仓库最早的一批测试，写法是自校验脚本（`assert` + `process.exit`），
 * 而不是 vitest 用例。它们覆盖了几个 vitest 从未触碰的模块（`utils/text`、
 * `utils/queryPreprocess`、`utils/dnsCache`、`core/validation/targetValidation` 等），
 * 但因为 CI 只跑 `npm run test:vitest`，这批覆盖**长期不产生任何保护**。
 *
 * 这里用显式白名单接进 CI。白名单必须手动维护：
 * - 只放不联网、不依赖浏览器、退出码可信的脚本；
 * - live 脚本（`test-*-live`、各引擎 smoke）留在 `npm run test:live`，绝不进 CI；
 * - 新增脚本时先本地 `node build/test/test-xxx.js` 跑一次，确认稳定再加进来。
 *
 * 注意 `stdio: 'inherit'`：部分受限环境（沙箱）无法为子进程创建管道，
 * 用 pipe 捕获输出会直接 EPERM。透传标准流在所有环境下都能跑。
 */
const DETERMINISTIC_TESTS = [
    'test-bing-parser',
    'test-browser-path-guard',
    'test-core-fetch-services',
    'test-core-search',
    'test-core-target-validation',
    'test-dns-cache',
    'test-duckduckgo-preload-url',
    'test-engine-normalization',
    'test-network-error',
    'test-pagination',
    'test-query-preprocess',
    'test-redirect-safety',
    'test-sogou',
    'test-text',
    'test-url-safety',
    'test-web-content'
] as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(here, '..', 'test');

const missing: string[] = [];
for (const name of DETERMINISTIC_TESTS) {
    if (!fs.existsSync(path.join(testDir, `${name}.js`))) {
        missing.push(name);
    }
}

if (missing.length > 0) {
    console.error(`❌ Compiled test scripts are missing: ${missing.join(', ')}`);
    console.error('   Run `npm run build` before `npm run test:deterministic`.');
    process.exit(1);
}

console.log(`Running ${DETERMINISTIC_TESTS.length} deterministic test scripts\n`);

const failures: string[] = [];
for (const name of DETERMINISTIC_TESTS) {
    console.log(`── ${name}`);
    const result = spawnSync(process.execPath, [path.join(testDir, `${name}.js`)], {
        stdio: 'inherit'
    });

    if (result.error) {
        failures.push(`${name} (failed to start: ${result.error.message})`);
        continue;
    }
    if (result.status !== 0) {
        failures.push(`${name} (exit ${result.status ?? 'signal'})`);
    }
}

if (failures.length > 0) {
    console.error(`\n❌ ${failures.length}/${DETERMINISTIC_TESTS.length} deterministic scripts failed:`);
    for (const failure of failures) {
        console.error(`   - ${failure}`);
    }
    process.exit(1);
}

console.log(`\n✅ ${DETERMINISTIC_TESTS.length} deterministic scripts passed`);
