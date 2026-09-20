/**
 * 默认引擎的查询感知路由（仅在 DEFAULT_SEARCH_ENGINE=auto 时启用）。
 *
 * 规则（基于实测对比：中文技术查询在国内引擎的召回质量显著更好——
 * 例如「DeepSeek Harness MCP 配置」在 bing 上返回首页/登录页等垃圾，
 * 在 baidu/sogou/csdn/juejin 上命中官方集成文档与社区教程）：
 *
 * - 查询含 ≥2 个 CJK 字符 → baidu（中文内容生态；不因夹带英文技术词而改判）
 * - 其余（纯英文 / 符号类查询）→ bing（英文与官方文档召回更稳）
 *
 * 显式指定 engines 时本逻辑不参与；非 auto 的默认引擎配置也不受影响。
 */

/** 判定为中文查询的最小 CJK 字符数（单个汉字可能是噪声/标点） */
const MIN_CJK_CHARS = 2;

export function pickDefaultEngineForQuery(query: string, configuredDefault: string): string {
    if (configuredDefault !== 'auto') {
        return configuredDefault;
    }

    const normalized = query.trim();
    if (!normalized) {
        return 'bing';
    }

    const cjkCount = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjkCount >= MIN_CJK_CHARS ? 'baidu' : 'bing';
}
