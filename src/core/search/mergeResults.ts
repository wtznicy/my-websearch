import { SearchResult } from '../../types.js';

/** 计算结果的规范化 URL 键，用于跨引擎去重。 */
export function normalizeResultUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        const host = parsed.hostname.toLowerCase();
        const isKnownSpmHost = /(^|\.)(csdn\.net|juejin\.cn|bilibili\.com|aliyun\.com|github\.com|gitee\.com|zhihu\.com)$/i.test(host);
        for (const key of [...parsed.searchParams.keys()]) {
            if (key.startsWith('utm_') || key === 'fbclid' || key === 'gclid' || key === 'msclkid') {
                parsed.searchParams.delete(key);
                continue;
            }
            if ((key === 'spm' || key === 'ops_request_misc' || key === 'request_id' || key === 'biz_id') && isKnownSpmHost) {
                parsed.searchParams.delete(key);
                continue;
            }
            if (key === 'tab' && (host === 'github.com' || host === 'gitee.com')) {
                parsed.searchParams.delete(key);
            }
        }
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            parsed.protocol = 'https:';
            parsed.hostname = host.startsWith('www.') ? host.slice(4) : host;
            if (parsed.pathname === '/') {
                parsed.pathname = '';
            }
        }
        return parsed.toString();
    } catch {
        return url.trim();
    }
}

/** 空描述占位结果：description 无实质内容且 title 过短，对 LLM 没有信息量。 */
export function isPlaceholderResult(result: SearchResult): boolean {
    const description = (result.description ?? '').trim();
    const hasSubstantiveDescription = description.length > 0 && !/^[\s.…·-]*$/.test(description);
    if (hasSubstantiveDescription) {
        return false;
    }
    const title = (result.title ?? '').trim();
    const hasSubstantiveTitle = title.length > 0 && !/^[\s.…·-]*$/.test(title);
    if (!hasSubstantiveTitle) {
        return true;
    }
    return title.length < 10;
}

/** RRF 融合开关：默认 legacy，设置 SEARCH_FUSION=rrf 启用（便于 bench A/B 对比） */
export function isRrfFusionEnabled(): boolean {
    return process.env.SEARCH_FUSION === 'rrf';
}

/** RRF 常数 k：2-3 个引擎时 60 会抹平差异，默认 20（可用 SEARCH_FUSION_RRF_K 覆盖） */
function getRrfK(): number {
    const parsed = Number(process.env.SEARCH_FUSION_RRF_K);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

/** 跨引擎融合：按规范化 URL 去重；默认按「命中引擎数 + 遍历序」，开启 RRF 后按排名倒数之和。 */
export function mergeSearchResults(engineResults: SearchResult[][]): SearchResult[] {
    const useRrf = isRrfFusionEnabled();
    const rrfK = getRrfK();
    const seen = new Map<string, { result: SearchResult; engines: Set<string>; order: number; rrf: number }>();
    let order = 0;

    for (const results of engineResults) {
        results.forEach((result, rankIndex) => {
            const key = normalizeResultUrl(result.url);
            const rank = rankIndex + 1;
            const contribution = 1 / (rrfK + rank);
            const existing = seen.get(key);
            if (existing) {
                existing.engines.add(result.engine);
                existing.rrf += contribution;
            } else {
                seen.set(key, { result, engines: new Set([result.engine]), order, rrf: contribution });
                order += 1;
            }
        });
    }

    const entries = [...seen.values()];
    entries.sort(useRrf
        // RRF：排名越靠前、被越多引擎推荐，分越高；同分用命中数、再按 URL 字典序保证确定性
        ? (a, b) => b.rrf - a.rrf || b.engines.size - a.engines.size || a.result.url.localeCompare(b.result.url)
        : (a, b) => b.engines.size - a.engines.size || a.order - b.order);

    return entries.map(({ result, engines, rrf }) => ({
        ...result,
        ...(engines.size > 1 ? { engineHits: engines.size } : {}),
        ...(useRrf ? { rrfScore: Math.round(rrf * 1e6) / 1e6 } : {})
    }));
}
