import { extractCoreTerms, isQueryDrift } from '../utils/queryGuard.js';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertContainsAll(actual: string[], expected: string[], message: string): void {
    for (const term of expected) {
        if (!actual.includes(term)) {
            throw new Error(`${message}: expected "${term}" in [${actual.join(', ')}]`);
        }
    }
}

function runCoreTermsCases(): void {
    // 品牌 + 英文/数字混合词都应提取为核心词
    const terms1 = extractCoreTerms('硅基流动 免费模型 Qwen3 DeepSeek');
    assertContainsAll(terms1, ['硅基流动', 'qwen3', 'deepseek'], 'core terms for brand query');

    // 含连字符/点号的专有名词形态
    const terms2 = extractCoreTerms('GLM-4.7-Flash 智谱 免费 API');
    assertContainsAll(terms2, ['glm-4.7-flash', '智谱'], 'core terms for GLM query');

    // 全停用词 → 无核心词
    assertEqual(extractCoreTerms('如何 免费 使用'), [], 'all stop words yield no core terms');
    assertEqual(extractCoreTerms('怎么 查询'), [], 'question-only query yields no core terms');

    // 无核心词的英文宽泛查询（hello/world 不在停用表，应保留——无害）
    const terms3 = extractCoreTerms('hello world');
    assertContainsAll(terms3, ['hello', 'world'], 'english query terms');

    // 单个汉字不构成核心词（防过度提取）
    assertEqual(extractCoreTerms('硅 的 用途'), ['用途'], 'single hanzi is not a core term');

    console.log('✅ extractCoreTerms: all cases passed');
}

function runDriftCases(): void {
    // 硅元素霸屏场景：查询"硅基流动"，结果全是"硅（化学元素）"→ 漂移
    const siliconResults = [
        { title: '硅（化学元素）_百度百科', description: '硅是元素周期表第14号元素…' },
        { title: '硅：地球的基石与科技的宠儿 - 知乎', description: '硅是一种化学元素…' },
        { title: '硅材料_百度百科', description: '硅 是一种化学元素…' }
    ];
    assertEqual(isQueryDrift(siliconResults, '硅基流动 免费模型'), true, 'off-topic results should drift');

    // 正常场景：结果标题包含核心词 → 不漂移
    const relevantResults = [
        { title: '硅基流动免费模型列表 2026', description: '硅基流动 SiliconFlow 免费 API 清单' },
        { title: 'DeepSeek 接入硅基流动免费 API', description: '零成本调用 DeepSeek' },
        { title: '硅基流动 SiliconFlow 免费模型', description: '7 个开源大语言模型 API' }
    ];
    assertEqual(isQueryDrift(relevantResults, '硅基流动 免费模型'), false, 'relevant results should not drift');

    // 部分命中：3 条命中 1 条（1/3 ≈ 0.33 >= 0.3）→ 不漂移（默认阈值）
    const partialResults = [
        { title: '硅基流动免费模型', description: '' },
        { title: '硅（化学元素）', description: '元素周期表' },
        { title: '化学元素大全', description: '硅 碳 氧' }
    ];
    assertEqual(isQueryDrift(partialResults, '硅基流动'), false, 'partial hits above threshold should not drift');

    // 空结果 → 不判定（避免把"真的没结果"当作漂移触发重试）
    assertEqual(isQueryDrift([], '硅基流动'), false, 'empty results should not drift');

    // 无核心词查询（全是停用词）→ 不判定
    assertEqual(isQueryDrift(siliconResults, '如何 免费 使用'), false, 'no core terms should not drift');

    // 自定义阈值：50% 时 3 条命中 1 条 → 漂移
    assertEqual(isQueryDrift(partialResults, '硅基流动', 0.5), true, 'custom threshold 0.5 should drift at 1/3 hits');

    console.log('✅ isQueryDrift: all cases passed');
}

runCoreTermsCases();
runDriftCases();
