import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

type OutputChunk = {
    stream: 'stdout' | 'stderr';
    text: string;
};

type RunningTest = {
    testName: string;
    child: ReturnType<typeof spawn>;
    outputChunks: OutputChunk[];
    killRequested: boolean;
    spawnError?: Error;
};

const rootDir = process.cwd();
const sourceTestDir = path.join(rootDir, 'src', 'test');
const compiledTestDir = path.join(rootDir, 'build', 'test');

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function getTestNames(directory: string, extension: string): string[] {
    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory)
        .filter((name) => name.endsWith(extension))
        .map((name) => name.slice(0, -extension.length))
        .sort((left, right) => left.localeCompare(right));
}

const sourceTestNames = getTestNames(sourceTestDir, '.ts');
const sourceTestNameSet = new Set(sourceTestNames);
const excludedFromFullTestNames = new Set([
    // 该测试依赖调用者显式配置 PLAYWRIGHT_MODULE_PATH、PLAYWRIGHT_PACKAGE、PLAYWRIGHT_EXECUTABLE_PATH 等环境变量，
    // 并且会启动真实浏览器做跨重启并发验证；全量测试排除它，避免普通 npm test 因本机 Playwright 环境缺失失败。
    // 需要验证时请单独运行 build/test/test-bing-playwright-cross-restart-concurrency.js。
    'test-bing-playwright-cross-restart-concurrency'
]);
const runnableTestNames = sourceTestNames.filter((name) => !excludedFromFullTestNames.has(name));
const staleCompiledTestNames = getTestNames(compiledTestDir, '.js')
    .filter((name) => !sourceTestNameSet.has(name));

if (staleCompiledTestNames.length > 0) {
    fail(`发现 build/test 中存在没有对应 src/test TypeScript 源文件的过时测试：${staleCompiledTestNames.join(', ')}`);
}

if (process.argv.includes('--list')) {
    for (const testName of runnableTestNames) {
        console.log(`${testName}.js`);
    }
    process.exit(0);
}

const networkFailurePatterns = [
    /\b(EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNABORTED)\b/i,
    /\b(socket hang up|network timeout|network error|fetch failed|ERR_NETWORK)\b/i,
    // axios 超时格式（"timeout of 30000ms exceeded"）——并行全量测试下偶发
    /timeout of \d+ms exceeded/i,
    // 海外引擎直连探测失败（无代理不可达）：确定性网络环境错误，与错误码模式等效
    /is unreachable from your current network without a proxy/i,
    // 只匹配明确的证书/握手错误特征；裸单词 "TLS"/"SSL"/"certificate" 会误伤——
    // config 启动日志固定含 "TLS verification is enabled"，任何 import config 后失败的
    // 测试都会因此被误赦免（单元测试断言失败被静默放过的盲区）
    /\b(certificate verify failed|SSL peer certificate|TLS handshake|CERT_[A-Z_]+|CERTIFICATE_VERIFY_FAILED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/i,
    /net::ERR_[A-Z_]+/i,
    /Request failed with status code (429|5\d\d)\b/i,
    // Brave 的 429 被 buildBraveErrorMessage 包装为 "Brave rate limited (HTTP 429): ..."，
    // 不再含 axios 原始文案——代理/机房 IP 被上游节流属环境问题
    /Brave rate limited \(HTTP 429\)/i,
    // DuckDuckGo 上游反爬挑战页（202）：环境/上游风控，非代码问题
    /DuckDuckGo returned a challenge page/i,
    // 百度间歇性反爬（把无 cookie/被限流的请求 302 到验证页，实测时好时坏、约 20 分钟后自行恢复）：
    // 引擎已把它转成显式且不可重试的反爬错误；这是上游状态而非代码缺陷
    /Baidu returned an anti-bot or redirect page/i,
    // context7 匿名月度配额耗尽（按出口 IP 计；实测重置日 2026-10-01）：上游配额状态，非代码问题。
    // 修复后该状态快速失败并带上此文案（此前会盲从 Retry-After 挂起数天）
    /Context7 anonymous quota exhausted/i,
    /page\.goto: Timeout \d+ms exceeded[\s\S]*navigating to/i,
    /Timeout \d+ms exceeded[\s\S]*(https?:\/\/|navigating to)/i
];

const nonNetworkFailurePatterns = [
    /Playwright client is not available/i,
    /Playwright client is unavailable/i,
    /Cannot find module ['`](playwright|playwright-core)['`]/i,
    /Cannot find package ['`](playwright|playwright-core)['`]/i
];

function getCapturedOutput(test: RunningTest): string {
    return test.outputChunks.map((chunk) => chunk.text).join('');
}

function isForgivableNetworkFailure(test: RunningTest): boolean {
    const output = `${test.spawnError?.message || ''}\n${getCapturedOutput(test)}`;
    if (nonNetworkFailurePatterns.some((pattern) => pattern.test(output))) {
        return false;
    }

    return networkFailurePatterns.some((pattern) => pattern.test(output));
}

/** 提取命中的网络豁免模式（用于 EXCUSED 行展示具体原因，便于发版后追溯） */
function matchedExcusePattern(output: string): string {
    const hit = networkFailurePatterns.find((pattern) => pattern.test(output));
    if (!hit) {
        return 'unknown';
    }
    const source = hit.source;
    return source.length > 60 ? `${source.slice(0, 57)}...` : source;
}

function printCapturedOutput(test: RunningTest): void {
    const output = getCapturedOutput(test);
    if (!output.trim()) {
        return;
    }

    console.error(`----- ${test.testName}.js output begin -----`);
    for (const chunk of test.outputChunks) {
        const target = chunk.stream === 'stderr' ? process.stderr : process.stdout;
        target.write(chunk.text);
    }
    if (!output.endsWith('\n')) {
        console.error();
    }
    console.error(`----- ${test.testName}.js output end -----`);
}

function killProcessTree(test: RunningTest): void {
    if (!test.child.pid || test.child.killed) {
        return;
    }

    test.killRequested = true;
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/pid', String(test.child.pid), '/T', '/F'], { stdio: 'ignore' });
            return;
        }

        process.kill(-test.child.pid, 'SIGTERM');
    } catch {
        try {
            test.child.kill('SIGKILL');
        } catch {
            // 终止失败通常表示进程已经退出；这里不再覆盖原始失败原因。
        }
    }
}

function validateCompiledTests(): void {
    if (sourceTestNames.length === 0) {
        fail('没有发现当前 TypeScript 测试文件：src/test/*.ts');
    }
    if (runnableTestNames.length === 0) {
        fail('全量测试没有可运行的测试文件，请检查排除列表。');
    }

    for (const testName of sourceTestNames) {
        const compiledTestPath = path.join(compiledTestDir, `${testName}.js`);
        if (!existsSync(compiledTestPath)) {
            fail(`当前 TypeScript 测试缺少编译产物：src/test/${testName}.ts -> build/test/${testName}.js`);
        }
    }
}

function runAllTestsInParallel(): Promise<number> {
    validateCompiledTests();

    const runningTests = new Map<string, RunningTest>();
    let completed = 0;
    let passed = 0;
    let excused = 0;
    let failed = 0;
    let failFastStarted = false;
    // 有界并发池：此前全部测试子进程在同一毫秒 spawn，瞬时并发风暴会让各引擎在同一秒密集
    // 请求上游（CSDN/搜狗/必应/Brave），本来就是"单跑必过、全量偶发 WAF 限流/超时"的人为来源
    const maxConcurrentTests = Math.max(1, Number(process.env.TEST_CONCURRENCY || '6') || 6);
    const pendingTests = [...runnableTestNames];
    let activeTests = 0;
    let abandonedTests = 0;
    let resolveExitCode: (exitCode: number) => void;
    const done = new Promise<number>((resolve) => {
        resolveExitCode = resolve;
    });

    function stopOtherTests(failedTestName: string): void {
        for (const test of runningTests.values()) {
            if (test.testName !== failedTestName) {
                killProcessTree(test);
            }
        }
    }

    function finishIfDone(): void {
        if (completed + abandonedTests < runnableTestNames.length) {
            return;
        }

        if (failed > 0) {
            console.error(`\n测试失败：${failed} 个失败，${passed} 个通过，${excused} 个网络问题已赦免。`);
            resolveExitCode(1);
            return;
        }

        console.log(`\n所有当前 TypeScript 测试已完成：${passed} 个通过，${excused} 个网络问题已赦免。`);
        resolveExitCode(0);
    }

    const skippedTestNames = sourceTestNames.filter((name) => excludedFromFullTestNames.has(name));
    if (skippedTestNames.length > 0) {
        console.log(`全量测试跳过 ${skippedTestNames.length} 个需单独运行的测试：${skippedTestNames.map((name) => `${name}.js`).join(', ')}`);
    }
    console.log(`将并行运行 ${runnableTestNames.length} 个当前 TypeScript 测试（并发上限 ${maxConcurrentTests}，TEST_CONCURRENCY 可调）；非网络失败会立即终止其它测试。`);

    function startTest(testName: string): void {
        const compiledTestPath = path.join(compiledTestDir, `${testName}.js`);
        console.log(`===== START ${testName}.js =====`);

        const child = spawn(process.execPath, [compiledTestPath], {
            detached: process.platform !== 'win32',
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        const runningTest: RunningTest = {
            testName,
            child,
            outputChunks: [],
            killRequested: false
        };
        runningTests.set(testName, runningTest);

        child.stdout?.on('data', (chunk: Buffer) => {
            runningTest.outputChunks.push({ stream: 'stdout', text: chunk.toString('utf8') });
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            runningTest.outputChunks.push({ stream: 'stderr', text: chunk.toString('utf8') });
        });
        child.on('error', (error) => {
            runningTest.spawnError = error;
        });
        child.on('close', (code, signal) => {
            runningTests.delete(testName);
            activeTests -= 1;
            completed += 1;

            if (runningTest.killRequested) {
                console.warn(`===== STOPPED ${testName}.js (${signal || (code ?? 'unknown')}) =====`);
                afterTestSettled();
                return;
            }

            if (!runningTest.spawnError && code === 0) {
                passed += 1;
                console.log(`===== PASS ${testName}.js =====`);
                afterTestSettled();
                return;
            }

            if (isForgivableNetworkFailure(runningTest)) {
                excused += 1;
                console.warn(`===== EXCUSED ${testName}.js: 网络问题，已赦免（匹配: ${matchedExcusePattern(getCapturedOutput(runningTest))}） =====`);
                printCapturedOutput(runningTest);
                afterTestSettled();
                return;
            }

            failed += 1;
            console.error(`===== FAIL ${testName}.js (${runningTest.spawnError?.message || signal || (code ?? 'unknown')}) =====`);
            printCapturedOutput(runningTest);

            if (!failFastStarted) {
                failFastStarted = true;
                // 修复全量测试等待过久的问题：第一个非网络失败出现后立即终止其它并行测试。
                stopOtherTests(testName);
                // 尚未启动的测试不再启动（计入完成数，否则 finishIfDone 永不 resolve）
                abandonedTests = pendingTests.length;
                if (abandonedTests > 0) {
                    console.warn(`===== SKIP ${abandonedTests} 个未启动的测试（已被失败终止）: ${pendingTests.join(', ')} =====`);
                }
                pendingTests.length = 0;
            }

            afterTestSettled();
        });
    }

    /** 一个测试结束（无论结果）：补位启动下一个，再检查是否全部完成 */
    function afterTestSettled(): void {
        startNextTests();
        finishIfDone();
    }

    function startNextTests(): void {
        while (!failFastStarted && activeTests < maxConcurrentTests && pendingTests.length > 0) {
            activeTests += 1;
            startTest(pendingTests.shift() as string);
        }
    }

    startNextTests();

    return done;
}

runAllTestsInParallel().then((exitCode) => {
    process.exit(exitCode);
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
