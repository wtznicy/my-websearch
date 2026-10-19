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

/** 跨引擎融合：按规范化 URL 去重，并按“被多少个引擎命中”加权排序。 */
export function mergeSearchResults(engineResults: SearchResult[][]): SearchResult[] {
    const seen = new Map<string, { result: SearchResult; engines: Set<string>; order: number }>();
    let order = 0;

    for (const results of engineResults) {
        for (const result of results) {
            const key = normalizeResultUrl(result.url);
            const existing = seen.get(key);
            if (existing) {
                existing.engines.add(result.engine);
            } else {
                seen.set(key, { result, engines: new Set([result.engine]), order });
                order += 1;
            }
        }
    }

    return [...seen.values()]
        .sort((a, b) => b.engines.size - a.engines.size || a.order - b.order)
        .map(({ result, engines }) => (engines.size > 1 ? { ...result, engineHits: engines.size } : result));
}
