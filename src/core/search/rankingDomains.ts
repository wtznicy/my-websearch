import { config } from '../../config.js';
import { extractRootDomain } from './mergeResults.js';

/**
 * 领域权威白名单（纯正官方文档/标准库/技术规范与学术站点；可用 SEARCH_AUTHORITY_DOMAINS 追加）。
 * 注意：严禁收录掘金、CSDN、知乎、博客园等 UGC 社区，避免社区二次搬运站压制原始官方文档。
 */
export const DEFAULT_AUTHORITY_DOMAINS = [
    // 官方规范与核心平台
    'modelcontextprotocol.io',
    'vitest.dev',
    'vite.dev',
    'vitejs.dev',
    'github.com',
    'stackoverflow.com',
    'developer.mozilla.org',
    'nodejs.org',
    'docs.python.org',
    'python.org',
    'docs.rs',
    'rust-lang.org',
    'npmjs.com',
    'wikipedia.org',
    'wikimedia.org',
    'arxiv.org',
    'news.ycombinator.com',
    'openai.com',
    'anthropic.com',
    'docs.aws.amazon.com',
    // 主流官方开发框架与规范文档站
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
    'pnpm.io',
    'playwright.dev',
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
    'nginx.org',
    'prisma.io',
    'astro.build'
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
    if (
        /^docs\./.test(host)
        || /\.github\.io$/.test(host)
        || /^developer\./.test(host)
        || /\.readthedocs\.io$/.test(host)
        || host.endsWith('.dev')
        || host === 'modelcontextprotocol.io'
        || host.endsWith('.modelcontextprotocol.io')
        || host === 'nodejs.org'
        || host.endsWith('.nodejs.org')
    ) {
        return true;
    }
    if (getAuthorityDomains(customDomains).some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return true;
    }
    return false;
}
