/**
 * 官方意图感知与权威补召回（Official Intent Recognition & Recall Injection）
 *
 * 当用户查询具有明确的官方/规范意图（如“官方文档”、“官网”、“specification”、“official docs”），
 * 且主流搜索引擎由于中文生态偏差或索引滞后，未能召回任何对应官方域名时，
 * 为候选池安全注入经过核验的权威官方条目，杜绝“巧妇难为无米之炊”导致的官方文档缺失。
 */

import type { SearchResult } from '../../types.js';
import { metrics } from '../metrics.js';

export interface OfficialEntityDefinition {
    id: string;
    canonicalName: string;
    aliasRegex: RegExp;
    domains: string[];
    defaultUrl: string;
    zhUrl?: string;
    /** 版本/发布页意图（如“最新 LTS 版本”），命中时即使没有“官方”字样也补召回 */
    versionIntentRegex?: RegExp;
    versionUrl?: string;
    zhVersionUrl?: string;
    description: string;
}

/** 常见高频前沿开源项目与技术规范权威白名单（按需轻量收录，避免庞大静态表） */
export const KNOWN_OFFICIAL_ENTITIES: readonly OfficialEntityDefinition[] = [
    {
        id: 'mcp',
        canonicalName: 'Model Context Protocol (MCP)',
        aliasRegex: /\b(mcp|model\s*context\s*protocol)\b/i,
        domains: ['modelcontextprotocol.io'],
        defaultUrl: 'https://modelcontextprotocol.io/',
        description: 'Open standard for secure, two-way connections between AI applications and data sources, tools, or development environments.'
    },
    {
        id: 'vitest',
        canonicalName: 'Vitest',
        aliasRegex: /\bvitest\b/i,
        domains: ['vitest.dev'],
        defaultUrl: 'https://vitest.dev/',
        zhUrl: 'https://cn.vitest.dev/',
        description: 'Next generation testing framework powered by Vite. Fast, native ESM, TypeScript and JSX support out of the box.'
    },
    {
        id: 'nodejs',
        canonicalName: 'Node.js',
        aliasRegex: /\b(nodejs|node\.js)\b/i,
        domains: ['nodejs.org'],
        defaultUrl: 'https://nodejs.org/en',
        zhUrl: 'https://nodejs.org/zh-cn',
        versionIntentRegex: /\b(lts|releases?|schedule)\b|最新.*版本|长期支持|稳定版/i,
        versionUrl: 'https://nodejs.org/en/about/previous-releases',
        zhVersionUrl: 'https://nodejs.org/zh-cn/about/previous-releases',
        description: 'Open-source, cross-platform JavaScript runtime environment that executes JavaScript code outside a web browser.'
    },
    {
        id: 'nextjs',
        canonicalName: 'Next.js',
        aliasRegex: /\b(nextjs|next\.js)\b/i,
        domains: ['nextjs.org'],
        defaultUrl: 'https://nextjs.org/docs',
        description: 'The React Framework for the Web. Used by some of the world\'s largest companies to build full-stack web applications.'
    },
    {
        id: 'react',
        canonicalName: 'React',
        aliasRegex: /\breact(\.js|js)?\b/i,
        domains: ['react.dev'],
        defaultUrl: 'https://react.dev/',
        zhUrl: 'https://zh-hans.react.dev/',
        description: 'The library for web and native user interfaces. Build user interfaces out of individual pieces called components.'
    },
    {
        id: 'vue',
        canonicalName: 'Vue.js',
        aliasRegex: /\b(vue|vuejs|vue\.js)\b/i,
        domains: ['vuejs.org'],
        defaultUrl: 'https://vuejs.org/',
        zhUrl: 'https://cn.vuejs.org/',
        description: 'The Progressive JavaScript Framework. Approachable, performant and versatile framework for building web user interfaces.'
    },
    {
        id: 'typescript',
        canonicalName: 'TypeScript',
        aliasRegex: /\b(typescript|ts)\b/i,
        domains: ['typescriptlang.org'],
        defaultUrl: 'https://www.typescriptlang.org/docs/',
        zhUrl: 'https://www.typescriptlang.org/zh/docs/',
        description: 'TypeScript is a strongly typed programming language that builds on JavaScript, giving you better tooling at any scale.'
    },
    {
        id: 'docker',
        canonicalName: 'Docker',
        aliasRegex: /\bdocker\b/i,
        domains: ['docker.com'],
        defaultUrl: 'https://docs.docker.com/',
        description: 'Accelerate how you build, share, and run applications. Official documentation for Docker engine, compose, and CLI.'
    },
    {
        id: 'postgresql',
        canonicalName: 'PostgreSQL',
        aliasRegex: /\b(postgresql|postgres)\b/i,
        domains: ['postgresql.org', 'postgres.cn'],
        defaultUrl: 'https://www.postgresql.org/docs/',
        description: 'PostgreSQL: The World\'s Most Advanced Open Source Relational Database. Official documentation, manuals, and releases.'
    },
    {
        id: 'zustand',
        canonicalName: 'Zustand',
        aliasRegex: /\bzustand\b/i,
        domains: ['pmnd.rs'],
        defaultUrl: 'https://zustand.docs.pmnd.rs/',
        description: 'A small, fast, and scalable bearbones state management solution for React using simplified flux principles.'
    }
];

export const OFFICIAL_INTENT_REGEX = /(官方文档|官方|官网|开发者文档|开发文档|官方规范|规范|标准|specification|spec\b|docs?\b|documentation|official)/i;

/** 判断查询是否表达了权威官方文档/官网意图 */
export function hasOfficialIntent(query: string): boolean {
    if (!query) return false;
    return OFFICIAL_INTENT_REGEX.test(query);
}

/** 识别查询中匹配的已知核心官方实体 */
export function matchOfficialEntity(query: string): OfficialEntityDefinition | undefined {
    if (!query) return undefined;
    for (const entity of KNOWN_OFFICIAL_ENTITIES) {
        if (entity.aliasRegex.test(query)) {
            return entity;
        }
    }
    return undefined;
}

function hasAnyDomainInResults(results: SearchResult[], domains: string[]): boolean {
    const domainSet = new Set(domains.map((d) => d.toLowerCase()));
    return results.some((r) => {
        try {
            const host = new URL(r.url).hostname.toLowerCase();
            return [...domainSet].some((d) => host === d || host.endsWith(`.${d}`));
        } catch {
            return false;
        }
    });
}

/**
 * 在官方意图确立且候选结果中缺失官方域时，安全注入官方权威锚点条目
 */
export function injectOfficialRecallIfNeeded(
    results: SearchResult[],
    query: string
): SearchResult[] {
    const entity = matchOfficialEntity(query);
    if (!entity) {
        return results;
    }

    const isChinese = /[\u4e00-\u9fff]/.test(query);
    const wantsVersion = Boolean(entity.versionUrl && entity.versionIntentRegex?.test(query));

    // 版本/发布页意图（如“Node.js 最新 LTS 版本”）：即使没有“官方”字样，也补召回官方版本页
    if (wantsVersion) {
        const versionUrl = (isChinese && entity.zhVersionUrl) ? entity.zhVersionUrl : entity.versionUrl!;
        if (results.some((r) => r.url.trim().toLowerCase().startsWith(versionUrl.toLowerCase()))) {
            return results;
        }
        const versionItem: SearchResult = {
            title: isChinese
                ? `${entity.canonicalName} 版本与 LTS 发布说明`
                : `${entity.canonicalName} Releases & LTS Schedule`,
            url: versionUrl,
            description: isChinese
                ? `${entity.canonicalName} 官方发布记录与 LTS 时间表（含当前 LTS 版本）。`
                : `Official ${entity.canonicalName} release history and LTS schedule (including the current LTS line).`,
            source: 'official',
            engine: 'official',
            rankBoost: 0.35
        };
        metrics.debug(`[officialRecall] Injected version entry for ${entity.id} (${versionUrl})`);
        return [versionItem, ...results];
    }

    if (!hasOfficialIntent(query)) {
        return results;
    }

    // 若结果中已包含该实体的任何官方域名，说明上游已正常召回，无需人工干预
    if (hasAnyDomainInResults(results, entity.domains)) {
        return results;
    }

    const targetUrl = (isChinese && entity.zhUrl) ? entity.zhUrl : entity.defaultUrl;
    const title = isChinese
        ? `${entity.canonicalName} 官方文档与权威规范`
        : `${entity.canonicalName} Official Documentation & Specification`;

    const officialItem: SearchResult = {
        title,
        url: targetUrl,
        description: entity.description,
        source: 'official',
        engine: 'official',
        rankBoost: 0.35
    };

    metrics.debug(`[officialRecall] Injected missing official entry for ${entity.id} (${targetUrl})`);

    // 注入到候选池头部，由后续统一的 rankSearchResults 进行公平 BM25/权威度评估
    return [officialItem, ...results];
}
