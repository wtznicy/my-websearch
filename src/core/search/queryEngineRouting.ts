/**
 * 默认引擎的查询感知路由（仅在 DEFAULT_SEARCH_ENGINE=auto 时启用）。
 *
 * 规则（基于实测对比）：
 * - 查询含 ≥2 个 CJK 字符 → 中文引擎组（默认 baidu）——中文技术查询在国内引擎的
 *   召回质量显著更好（例：「DeepSeek Harness MCP 配置」在 bing 上返回首页/登录页，
 *   在 baidu/sogou/csdn/juejin 上命中官方集成文档与社区教程）
 * - 其余（纯英文 / 符号类查询）→ 英文引擎组（默认 bing + duckduckgo 并列）——
 *   不把英文质量押在 bing 单点：实测其对含域名的长尾技术 query 会退化成站点首页
 *
 * 引擎组可用 AUTO_ROUTE_EN_ENGINES / AUTO_ROUTE_ZH_ENGINES 覆盖；
 * 显式指定 engines 时本逻辑不参与；非 auto 的默认引擎配置也不受影响。
 */

/** 判定为中文查询的最小 CJK 字符数（单个汉字可能是噪声/标点） */
const MIN_CJK_CHARS = 2;

const DEFAULT_EN_ENGINES = ['bing', 'duckduckgo'];
const DEFAULT_ZH_ENGINES = ['baidu'];

/** 路由引擎组：auto 模式返回一组引擎（组内并列执行、融合去重） */
export function pickDefaultEnginesForQuery(
    query: string,
    configuredDefault: string,
    routing?: { en?: string[]; zh?: string[] }
): string[] {
    if (configuredDefault !== 'auto') {
        return [configuredDefault];
    }

    const enEngines = routing?.en && routing.en.length > 0 ? routing.en : DEFAULT_EN_ENGINES;
    const zhEngines = routing?.zh && routing.zh.length > 0 ? routing.zh : DEFAULT_ZH_ENGINES;

    const normalized = query.trim();
    if (!normalized) {
        return [...enEngines];
    }

    const cjkCount = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjkCount >= MIN_CJK_CHARS ? [...zhEngines] : [...enEngines];
}

/** 兼容单引擎调用方（返回路由组的首个引擎） */
export function pickDefaultEngineForQuery(query: string, configuredDefault: string): string {
    return pickDefaultEnginesForQuery(query, configuredDefault)[0];
}
