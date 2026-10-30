import { spawnSync } from 'node:child_process';
import path from 'node:path';

const runs = Math.max(1, Number(process.argv[2]) || 10);
const files = process.argv.slice(3);
const vitestEntry = path.resolve('node_modules', 'vitest', 'vitest.mjs');

if (files.length === 0) {
    files.push('src/test/vitest/search-outcome-and-doctor.test.ts');
}

console.log(`Running timing-sensitive Vitest ${runs} times: ${files.join(', ')}`);

for (let index = 1; index <= runs; index += 1) {
    console.log(`--- timing run ${index}/${runs} ---`);
    const result = spawnSync(process.execPath, [vitestEntry, 'run', ...files], {
        stdio: 'inherit',
        env: process.env
    });
    if (result.error) {
        console.error(`Failed to start Vitest: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(`Timing-sensitive test failed on run ${index}/${runs}`);
        process.exit(result.status ?? 1);
    }
}

console.log(`Timing-sensitive tests passed ${runs}/${runs} runs.`);
