/**
 * 默认引擎的查询感知路由（仅在 DEFAULT_SEARCH_ENGINE=auto 时启用）。
 *
 * 规则（基于实测对比）：
 * - 查询含 ≥2 个 CJK 字符 → 中文引擎组（默认 baidu + sogou 并列执行、融合去重）——中文技术查询在国内引擎的
 *   召回质量显著更好（例：「DeepSeek Harness MCP 配置」在 bing 上返回首页/登录页，
 *   在 baidu/sogou/csdn/juejin 上命中官方集成文档与社区教程）
 * - 其余（纯英文 / 符号类查询）→ 英文引擎组（默认 bing + duckduckgo 并列）——
 *   不把英文质量押在 bing 单点：实测其对含域名的长尾技术 query 会退化成站点首页
 *
 * 显式指定 engines 时本逻辑不参与；非 auto 的默认引擎配置也不受影响。
 */

import { isEngineCircuitOpen } from './engineCircuitBreaker.js';
import { metrics } from '../metrics.js';

/** 判定为中文查询的最小 CJK 字符数（单个汉字可能是噪声/标点） */
const MIN_CJK_CHARS = 2;

const DEFAULT_EN_ENGINES = ['bing', 'duckduckgo'];
const DEFAULT_ZH_ENGINES = ['baidu', 'sogou'];
const DEFAULT_MIXED_TECH_ENGINES = ['bing', 'juejin', 'baidu'];

function parseEnvEngineList(raw: string | undefined): string[] | undefined {
    if (!raw || !raw.trim()) {
        return undefined;
    }
    const list = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    return list.length > 0 ? list : undefined;
}

function isEngineHealthyForPrimaryRouting(engine: string): boolean {
    if (isEngineCircuitOpen(engine)) {
        return false;
    }
    const health = metrics.getRecentEngineHealth(engine);
    if (health && health.total >= 2 && health.successRate < 50) {
        return false;
    }
    return true;
}

/**
 * P1-6：主引擎组健康度过滤与替补：
 * 当默认路由组中的某个引擎处于熔断期、或近期窗口内连续失败（样本 ≥2 且成功率 <50%，如 duckduckgo 连续超时）时，
 * 自动将其从主引擎组剔除，并从同语种替补池（英文优先 exa/brave，中文优先 csdn/juejin/bing）补齐，
 * 避免主引擎组持续挂着一个 100% 失败的引擎白白消耗配额与超时预算。
 */
function applyPrimaryHealthFilter(baseGroup: string[], isChinese: boolean, hasCustomOverride: boolean): string[] {
    const healthyBase = baseGroup.filter((engine) => isEngineHealthyForPrimaryRouting(engine));
    if (healthyBase.length === baseGroup.length) {
        return [...baseGroup];
    }
    // 用户显式自定义了路由列表时，仅剔除不健康引擎（全不健康则保底返回原列表）
    if (hasCustomOverride) {
        return healthyBase.length > 0 ? healthyBase : [...baseGroup];
    }

    const result = [...healthyBase];
    const hasExaKey = Boolean(process.env.EXA_API_KEY?.trim());
    // 替补必须是**同类通用搜索引擎**：CSDN/掘金是站内技术库，拿它顶替百度会让
    // 「杭州落户政策」「今天天气」这类查询直接 0 结果（可用性换延迟是亏本买卖）。
    // 垂直引擎只在查询被判定为代码/学术特征时才由路由显式拉入。
    const fallbackPool = isChinese
        ? ['bing', 'sogou', 'baidu']
        : [...(hasExaKey ? ['exa'] : []), 'brave', 'duckduckgo', 'bing'];

    for (const candidate of fallbackPool) {
        if (result.length >= baseGroup.length) {
            break;
        }
        if (!result.includes(candidate) && isEngineHealthyForPrimaryRouting(candidate)) {
            result.push(candidate);
        }
    }

    return result.length > 0 ? result : [...baseGroup];
}

/** 路由引擎组：auto 模式返回一组引擎（组内并列执行、融合去重） */
export function pickDefaultEnginesForQuery(
    query: string,
    configuredDefault: string,
    routing?: { en?: string[]; zh?: string[]; mixed?: string[] }
): string[] {
    if (configuredDefault !== 'auto') {
        return [configuredDefault];
    }

    const envEn = parseEnvEngineList(process.env.AUTO_ROUTE_EN_ENGINES);
    const envZh = parseEnvEngineList(process.env.AUTO_ROUTE_ZH_ENGINES);
    const envMixed = parseEnvEngineList(process.env.AUTO_ROUTE_MIXED_ENGINES);

    const customEn = routing?.en && routing.en.length > 0 ? routing.en : envEn;
    const customZh = routing?.zh && routing.zh.length > 0 ? routing.zh : envZh;
    const customMixed = routing?.mixed && routing.mixed.length > 0 ? routing.mixed : envMixed;

    const enEngines = customEn ?? DEFAULT_EN_ENGINES;
    const zhEngines = customZh ?? DEFAULT_ZH_ENGINES;
    const mixedEngines = customMixed ?? DEFAULT_MIXED_TECH_ENGINES;

    const normalized = query.trim();
    if (!normalized) {
        return applyPrimaryHealthFilter(enEngines, false, Boolean(customEn));
    }

    const cjkCount = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
    const isChinese = cjkCount >= MIN_CJK_CHARS;

    if (isChinese) {
        // 中英混合技术查询：包含英文词（3+字符）或常见技术缩写，路由给 ['bing', 'juejin', 'baidu']
        const hasTechTerms = /[a-zA-Z]{3,}/.test(normalized) || /\b(js|ts|go|c\+\+|ui|ai|os|db|k8s|ci|cd)\b/i.test(normalized);
        if (hasTechTerms) {
            return applyPrimaryHealthFilter(mixedEngines, true, Boolean(customMixed));
        }
        // 纯中文通用查询：路由给 ['baidu', 'sogou']
        return applyPrimaryHealthFilter(zhEngines, true, Boolean(customZh));
    }

    // 纯英文/符号查询：路由给 ['bing', 'duckduckgo']
    return applyPrimaryHealthFilter(enEngines, false, Boolean(customEn));
}

/** 兼容单引擎调用方（返回路由组的首个引擎） */
export function pickDefaultEngineForQuery(
    query: string,
    configuredDefault: string,
    routing?: { en?: string[]; zh?: string[] }
): string {
    return pickDefaultEnginesForQuery(query, configuredDefault, routing)[0] ?? (configuredDefault || 'bing');
}

