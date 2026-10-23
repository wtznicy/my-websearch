import type { SearchResult } from '../../types.js';

const MAX_DESCRIPTION_CHARS = 400;

/**
 * P2-15：搜索结果的统一出口。
 *
 * 各引擎历史上各写各的：description 截断 250/300/400 混用，source 语义四种混用
 * （站点名 / 作者昵称 / hostname / 仓库名），URL 合法性只有 baidu/bing 校验。
 * 出口不统一时，下游的时间过滤、去重和后续 canary 骤降检测都没有稳定断言面。
 *
 * 返回 null 表示这条结果不可用（URL 非法/协议不支持），调用方应当丢弃。
 */
export function normalizeSearchResult(raw: SearchResult): SearchResult | null {
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
    }

    const title = (raw.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) {
        return null;
    }

    const description = (raw.description ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
    const source = (raw.source ?? '').trim() || parsed.hostname.replace(/^www\./, '');

    return {
        ...raw,
        title,
        url,
        description,
        source,
        engine: raw.engine
    };
}
