import { config } from '../../config.js';
import { extractRootDomain } from './mergeResults.js';

/** 领域权威白名单（文档/代码/百科类站点；可用 SEARCH_AUTHORITY_DOMAINS 追加） */
export const DEFAULT_AUTHORITY_DOMAINS = [
    'github.com',
    'stackoverflow.com',
    'stackexchange.com',
    'developer.mozilla.org',
    'docs.python.org',
    'docs.rs',
    'npmjs.com',
    'nodejs.org',
    'python.org',
    'rust-lang.org',
    'wikipedia.org',
    'wikimedia.org',
    'arxiv.org',
    'news.ycombinator.com',
    'zhihu.com',
    'juejin.cn',
    'segmentfault.com',
    'cnblogs.com',
    'openai.com',
    'anthropic.com',
    'docs.aws.amazon.com',
    // 主流官方文档站（中文查询容易被 runoob/镜像站挤占，官方站需要加权）
    'tailwindcss.com',
    'react.dev',
    'vuejs.org',
    'angular.dev',
    'angular.io',
    'nextjs.org',
    'svelte.dev',
    'typescriptlang.org',
    'deno.com',
    'bun.sh',
    'vitejs.dev',
    'webpack.js.org',
    'fastapi.tiangolo.com',
    'docs.djangoproject.com',
    'spring.io',
    'kubernetes.io',
    'docs.docker.com',
    'postgresql.org',
    'dev.mysql.com',
    'redis.io',
    'go.dev',
    'golang.org',
    'kotlinlang.org',
    'git-scm.com',
    'nginx.org'
];

export function getAuthorityDomains(customDomains?: string[]): string[] {
    const list = customDomains ?? config.authorityDomains;
    return list.length > 0
        ? [...DEFAULT_AUTHORITY_DOMAINS, ...list]
        : DEFAULT_AUTHORITY_DOMAINS;
}

export const COMMUNITY_DOMAINS = new Set([
    'juejin.cn',
    'csdn.net',
    'zhihu.com',
    'cnblogs.com',
    'segmentfault.com',
    'bilibili.com'
]);

/**
 * 判断是否属于真正的 Tier 1 官方文档/代码权威域：
 * 排除普通 UGC 社区站点（如掘金、知乎等），只有官方 docs.*、*.dev、*.github.io 等才算。
 */
export function isTier1OfficialDomain(rawUrl: string, customDomains?: string[]): boolean {
    let host = '';
    try {
        host = new URL(rawUrl).hostname.toLowerCase();
    } catch {
        return false;
    }
    const root = extractRootDomain(rawUrl);
    if (COMMUNITY_DOMAINS.has(root)) {
        return false;
    }
    if (/^docs\./.test(host) || /\.github\.io$/.test(host) || /^developer\./.test(host) || /\.readthedocs\.io$/.test(host) || host.endsWith('.dev')) {
        return true;
    }
    if (getAuthorityDomains(customDomains).some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return true;
    }
    return false;
}
