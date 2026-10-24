import { config } from '../../config.js';
export function hasSiteOperator(query: string): boolean {
    return /(^|\s)site:[^\s]+/i.test(query);
}

/**
 * 提取查询中所有 `site:domain` 限定的规范化域名（小写、剥离协议/路径/端口/前导 www.）。
 */
export function extractSiteDomains(query: string): string[] {
    const domains: string[] = [];
    for (const match of query.matchAll(/(?:^|\s)site:([^\s]+)/gi)) {
        const raw = (match[1] ?? '').trim()
            .replace(/^["']+|["',;.)\]]+$/g, '')
            .replace(/^https?:\/\//i, '');
        const hostPart = (raw.split('/')[0] ?? '').split(':')[0]?.toLowerCase().replace(/^\.+|^www\./, '') ?? '';
        if (hostPart && hostPart.includes('.') && !domains.includes(hostPart)) {
            domains.push(hostPart);
        }
    }
    return domains;
}

/**
 * 校验结果 URL 是否满足 `site:` 域名限定（精确匹配该域名或其子域名）。
 */
export function matchesSiteDomains(url: string, siteDomains: string[]): boolean {
    if (siteDomains.length === 0) {
        return true;
    }
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        return siteDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch {
        return false;
    }
}

export function shouldSuggestRemovingSiteOperator(query: string, error: unknown): boolean {
    if (!hasSiteOperator(query) || !(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('waitforselector') || message.includes('timeout');
}

export function buildBingSearchUrl(query: string, pageNumber: number, timeRange?: 'day' | 'week' | 'month' | 'year'): string {
    const baseUrl = config.bingBaseUrl;
    const url = new URL(baseUrl);
    url.searchParams.set('q', query);
    // 仅在 cn.bing.com（面向大陆默认）时强制 zh-CN 区域；自定义 host（如 www.bing.com）让 Bing 按访问者自动定位
    if (baseUrl.includes('cn.bing.com')) {
        url.searchParams.set('setlang', 'zh-CN');
        url.searchParams.set('ensearch', '0');
    }
    url.searchParams.set('first', String(1 + pageNumber * 10));
    if (timeRange) {
        const bingFilterMap: Record<string, string> = {
            day: 'ex1:"ez1"',
            week: 'ex1:"ez2"',
            month: 'ex1:"ez3"',
            year: 'ex1:"ez5"'
        };
        const filterVal = bingFilterMap[timeRange];
        if (filterVal) {
            url.searchParams.set('filters', filterVal);
        }
    }
    return url.toString();
}
