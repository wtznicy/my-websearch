/**
 * 默认引擎的查询感知路由（仅在 DEFAULT_SEARCH_ENGINE=auto 时启用）。
 *
 * 背景：不同引擎优势不同——百度对中文自然语言/百科类查询强，Bing 对英文与技术
 * 查询强，且 Bing 的热词结果易被 SEO 污染。auto 模式按查询特征选择默认引擎，
 * 减少 agent 每次手动指定 engines 的负担；显式指定 engines 时本逻辑不参与。
 *
 * 规则（保守，宁可用 bing 的通用性也不用错引擎）：
 * - 中文占比高且无技术特征 → baidu（中文内容/百科评测更优）
 * - 含英文长词、代码符号、包路径等技术特征 → bing
 * - 其余 → bing
 */

/** 连续 3 个以上英文字母（RAG、React、kubernetes），或代码/路径符号，视为技术查询 */
const TECHNICAL_HINT_PATTERN = /[a-zA-Z]{3,}|[{}()[\];<>#_=+*|\\]|::|\/\w|\.\w/;

export function pickDefaultEngineForQuery(query: string, configuredDefault: string): string {
    if (configuredDefault !== 'auto') {
        return configuredDefault;
    }

    const normalized = query.trim();
    if (!normalized) {
        return 'bing';
    }

    const cjkCount = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
    const cjkRatio = cjkCount / normalized.length;
    const looksTechnical = TECHNICAL_HINT_PATTERN.test(normalized);

    if (cjkRatio > 0.3 && !looksTechnical) {
        return 'baidu';
    }

    return 'bing';
}
