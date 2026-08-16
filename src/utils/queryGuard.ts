/**
 * 查询质量守护：检测搜索结果是否"漂移"（偏离查询主题）。
 *
 * 背景：Bing 等引擎对匿名自动化请求可能做软降级——不触发验证码，
 * 但返回与查询无关的低质量结果（如查询"硅基流动"却返回"硅（化学元素）"百科）。
 * 本模块提供核心词提取 + 漂移判定，供引擎在检测到漂移时换指纹重试。
 */

export type QueryGuardResultLike = {
    title?: string;
    description?: string;
};

/** 无区分度的词：出现查询中但不作为"主题锚点"，不参与相关性判定。
 * 注意只做整词匹配；组合词（如"免费模型"）不会被拆开过滤，
 * 它们作为更具体的主题词保留是安全的（正常结果标题同样会包含它们）。 */
const STOP_WORDS = new Set<string>([
    // 中文高频虚词
    '的', '了', '是', '在', '和', '与', '及', '或', '对', '为', '从', '到', '用', '把', '被', '让', '给', '就', '都', '也', '很', '有', '没',
    // 疑问/指代词
    '怎么', '如何', '什么', '为什么', '哪个', '哪些', '可以', '是否', '请问', '哪里', '多少', '怎样', '为什么', '怎么办',
    // 中文场景通用词（搜索意图修饰，非主题词）
    '免费', '模型', '调用', '搜索', '查询', '列表', '教程', '使用', '永久', '最新', '推荐', '大全', '合集', '汇总', '对比', '介绍',
    '注册', '申请', '获取', '下载', '安装', '配置', '设置', '工具', '平台', '服务', '功能',
    // 英文停用词
    'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with', 'and', 'or', 'is', 'are', 'be', 'it', 'this', 'that',
    'how', 'what', 'why', 'which', 'when', 'where', 'who', 'can', 'do', 'does', 'free'
]);

/**
 * 从查询中提取核心词：
 * - 连续 2+ 汉字的中文词
 * - 3+ 字符的英文/数字混合词（含连字符、点号，如 GLM-4.7-Flash、DeepSeek-V4）
 * 停用词整词剔除；无空格的连续串（如"如何免费使用"）作为整体保留。
 */
export function extractCoreTerms(query: string): string[] {
    const terms = new Set<string>();

    for (const match of query.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
        const term = match[0];
        if (!STOP_WORDS.has(term)) {
            terms.add(term);
        }
    }

    for (const match of query.matchAll(/[a-zA-Z][a-zA-Z0-9.\-]{2,}/g)) {
        const term = match[0].toLowerCase();
        if (!STOP_WORDS.has(term)) {
            terms.add(term);
        }
    }

    return [...terms];
}

/**
 * 判定结果集是否漂移（偏离查询主题）：
 * - 查询提不出核心词（全是停用词/单字）→ 不判定（false），避免对宽泛查询误触发
 * - 结果为空 → 不判定（false），空结果可能是真的没有，重试没有意义
 * - 命中任一核心词的结果占比 < 阈值（默认 30%）→ 漂移
 */
export function isQueryDrift(results: QueryGuardResultLike[], query: string, hitRatioThreshold = 0.3): boolean {
    const coreTerms = extractCoreTerms(query);
    if (coreTerms.length === 0) {
        return false;
    }
    if (results.length === 0) {
        return false;
    }

    const hitCount = results.reduce((count, result) => {
        const haystack = `${result.title ?? ''} ${result.description ?? ''}`.toLowerCase();
        return count + (coreTerms.some((term) => haystack.includes(term)) ? 1 : 0);
    }, 0);

    return hitCount / results.length < hitRatioThreshold;
}
