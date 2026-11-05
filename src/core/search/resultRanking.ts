import { SearchResult } from '../../types.js';
import { isRrfFusionEnabled, extractRootDomain } from './mergeResults.js';
import {
    DEFAULT_AUTHORITY_DOMAINS,
    getAuthorityDomains,
    COMMUNITY_DOMAINS,
    isTier1OfficialDomain
} from './rankingDomains.js';

export {
    DEFAULT_AUTHORITY_DOMAINS,
    getAuthorityDomains,
    COMMUNITY_DOMAINS,
    isTier1OfficialDomain
};

/**
 * 轻量本地结果重排（无外部依赖、毫秒级）。
 *
 * 融合打分权重：
 *   score = 0.40 * 位置分（保留搜索引擎自身排名先验，衰减）
 *         + 0.30 * 相关性（BM25：查询词与标题/摘要）
 *         + 0.20 * 权威度（域名白名单 / gov、edu）
 *         + 0.10 * 共识（engineHits）
 *         + 标题核心实体加分（+0.12）
 *         + 规范版本路径感知（+0.08~+0.12 / -0.12）
 *         + 时效性平滑线性微调（±0.12）
 *         - 站点入口页惩罚（-0.25）
 *         - 核心实体零命中硬护栏惩罚（-2.0）
 */

/** 文本分词：英文/数字词（长度 ≥2 或特定技术单字/独立数字/常见标记）+ 中文 bigram */
export function tokenizeForRanking(text: string): string[] {
    const tokens: string[] = [];
    const lower = text.toLowerCase();

    for (const match of lower.matchAll(/([a-z0-9]+[+#]*|[a-z]|\d+)/g)) {
        const token = match[0];
        if (token.length >= 2 || /^[crv\d]$/.test(token)) {
            tokens.push(token);
        }
    }

    const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of cjkRuns) {
        if (run.length === 1) {
            tokens.push(run);
            continue;
        }
        for (let i = 0; i < run.length - 1; i += 1) {
            tokens.push(run.slice(i, i + 2));
        }
    }

    return tokens;
}

/**
 * 判断 token 是否为具备实质语义的内容词：
 * 纯数字或单个非 CJK 字符不应单独充当“首词漂移检测”或“可用结果统计”的唯一区分通行证。
 */
export function isSubstantiveRankingToken(token: string): boolean {
    if (/^\d+$/.test(token)) {
        return false;
    }
    if (token.length < 2 && !/[\u4e00-\u9fff]/.test(token)) {
        return false;
    }
    return true;
}

/** 结果分词缓存（按 SearchResult 对象引用存储，跟随请求生命周期自动 GC） */
const docTokensCache = new WeakMap<SearchResult, string[]>();

export function getDocTokens(result: SearchResult): string[] {
    let tokens = docTokensCache.get(result);
    if (!tokens) {
        tokens = tokenizeForRanking(`${result.title} ${result.description}`);
        docTokensCache.set(result, tokens);
    }
    return tokens;
}

/** BM25 打分（k1=1.2, b=0.75），df/idf 在结果集内统计 */
function bm25Scores(queryTokens: string[], docs: string[][]): number[] {
    const total = docs.length;
    if (total === 0) {
        return [];
    }
    const k1 = 1.2;
    const b = 0.75;
    const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / total || 1;

    const documentFrequency = new Map<string, number>();
    for (const doc of docs) {
        for (const token of new Set(doc)) {
            documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
        }
    }

    return docs.map((doc) => {
        const termFrequency = new Map<string, number>();
        for (const token of doc) {
            termFrequency.set(token, (termFrequency.get(token) || 0) + 1);
        }

        let score = 0;
        for (const queryToken of queryTokens) {
            const frequency = termFrequency.get(queryToken);
            if (!frequency) {
                continue;
            }
            const df = documentFrequency.get(queryToken) || 0;
            const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
            score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * (doc.length / avgLength)));
        }
        return score;
    });
}

/** 域名权威度（0..1） */
function authorityScore(url: string, customDomains?: string[]): number {
    let host = '';
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return 0;
    }

    if (getAuthorityDomains(customDomains).some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return 1;
    }
    // 官方文档域：docs.*、*.github.io、developer.*、*.readthedocs.io、*.dev
    if (
        /^docs\./.test(host)
        || /\.github\.io$/.test(host)
        || /^developer\./.test(host)
        || /\.readthedocs\.io$/.test(host)
        || host.endsWith('.dev')
    ) {
        return 0.9;
    }
    if (/\.(gov|gov\.cn|edu|edu\.cn|ac\.cn)$/.test(host)) {
        return 0.8;
    }
    // 长域名/多连字符的营销域特征
    if (host.length > 30 || (host.match(/-/g) || []).length >= 4) {
        return 0;
    }
    return 0.3;
}

/** 疑似"站点入口页"（首页/登录/注册/索引） */
export function isLikelySiteEntryPage(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl);
        const path = url.pathname;
        if (path === '/' || path === '') {
            return true;
        }
        return /^\/(login|signin|sign-in|register|signup|index|home|account)(\/|$)/i.test(path);
    } catch {
        return false;
    }
}

/** 导航类查询（查询本身是域名或单一品牌词） */
function isNavigationalQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed) {
        return false;
    }
    if (/^[\w-]+(\.[a-z]{2,}){1,2}(\/.*)?$/i.test(trimmed)) {
        return true;
    }
    return /^[\w一-鿿-]{2,15}$/.test(trimmed);
}

export function relevanceScores(results: SearchResult[], query: string): number[] {
    const queryTokens = tokenizeForRanking(query || '');
    if (queryTokens.length === 0) {
        return results.map(() => 0);
    }
    const docs = results.map(getDocTokens);
    return bm25Scores(queryTokens, docs);
}

export function hasFirstTokenDrift(results: SearchResult[], query: string): boolean {
    const rawTokens = tokenizeForRanking(query || '');
    const substantive = rawTokens.filter(isSubstantiveRankingToken);
    const uniqueQueryTokens = [...new Set(substantive.length >= 2 ? substantive : rawTokens)];
    if (uniqueQueryTokens.length < 2 || results.length === 0) {
        return false;
    }
    const firstToken = uniqueQueryTokens[0]!;
    const tailTokens = uniqueQueryTokens.slice(1);
    const topSample = results.slice(0, Math.min(results.length, 5)).map(getDocTokens);
    const anyTopHitsFirst = topSample.some((doc) => doc.includes(firstToken));
    const anyTopHitsTail = topSample.some((doc) => {
        const docSet = new Set(doc);
        return tailTokens.some((token) => docSet.has(token));
    });
    return anyTopHitsFirst && !anyTopHitsTail;
}

const GENERIC_QUERY_TERMS = new Set([
    // 技术动作与形态通用词
    'configuration', 'config', 'setup', 'install', 'installation',
    'tutorial', 'guide', 'overview', 'docs', 'documentation', 'manual',
    'download', 'error', 'failed', 'issue', 'problem', 'fix',
    'solve', 'solution', 'how', 'what', 'why', 'use', 'using', 'usage',
    'example', 'examples', 'sample', 'official',
    // 时效与版本泛化修饰词（不可单靠它们充当核心实体）
    'latest', 'recent', 'newest', 'version', 'versions', 'v1', 'v2', 'v3', 'v4', 'v5',
    'lts', 'release', 'releases', 'current', 'update', 'updates', 'news', 'changelog',
    // 中文技术动作与形态通用词
    '官方', '官网', '配置', '安装', '教程', '指南', '文档', '手册', '下载', '报错',
    '错误', '解决', '怎么', '什么', '如何', '使用', '用法', '简介', '概述', '原理',
    '示例', '样例',
    // 中文时效与版本泛化修饰词
    '最新', '新版', '版本', '正式版', '稳定版', '发布', '更新', '动态', '中文文档', '中文教程'
]);

export function extractCoreQueryTokens(queryTokens: string[]): string[] {
    const substantive = queryTokens.filter(isSubstantiveRankingToken);
    const nonGeneric = substantive.filter((t) => !GENERIC_QUERY_TERMS.has(t));
    if (nonGeneric.length > 0) {
        return nonGeneric;
    }
    if (substantive.length > 0) {
        return substantive;
    }
    return queryTokens;
}

/**
 * 统计"可用结果"数（经 CJK 中文标定校准）：
 * 避免把多词中文技术查询中的合理结果误杀，同时严密拦截零相关的泛化噪声。
 */
export function countUsableResults(results: SearchResult[], query: string): number {
    const rawQueryTokens = tokenizeForRanking(query || '');
    if (rawQueryTokens.length === 0 || results.length === 0) {
        return results.length;
    }
    const substantive = rawQueryTokens.filter(isSubstantiveRankingToken);
    const queryTokens = substantive.length > 0 ? substantive : rawQueryTokens;
    const coreTokens = extractCoreQueryTokens(queryTokens);

    const docs = results.map(getDocTokens);
    const total = results.length;
    const documentFrequency = new Map<string, number>();
    for (const doc of docs) {
        const unique = new Set(doc);
        for (const token of queryTokens) {
            if (unique.has(token)) {
                documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
            }
        }
    }

    const uniqueQueryTokens = [...new Set(queryTokens)];
    if (uniqueQueryTokens.length >= 2) {
        const tailTokens = uniqueQueryTokens.slice(1);
        const topSample = docs.slice(0, Math.min(docs.length, 5));
        const anyTopHitsTail = topSample.some((doc) => {
            const docSet = new Set(doc);
            return tailTokens.some((token) => docSet.has(token));
        });
        if (!anyTopHitsTail) {
            return 0;
        }
    }

    const rarityCap = Math.ceil(Math.sqrt(total));
    const discriminativeTerms = uniqueQueryTokens.filter((token) => {
        const df = documentFrequency.get(token) || 0;
        return df > 0 && df < total && df <= rarityCap;
    });

    const hasNonGenericCore = substantive.some((t) => !GENERIC_QUERY_TERMS.has(t));
    const requiredTerms = discriminativeTerms.length > 0 ? discriminativeTerms : uniqueQueryTokens;
    const minHits = discriminativeTerms.length > 0 && hasNonGenericCore ? 1 : Math.min(2, requiredTerms.length);
    const highCoverageThreshold = Math.max(3, Math.ceil(uniqueQueryTokens.length * 0.75));

    const nonCoreTokens = uniqueQueryTokens.filter((t) => !coreTokens.includes(t));
    const nonCoreAreGeneric = nonCoreTokens.length > 0 && nonCoreTokens.every((t) => GENERIC_QUERY_TERMS.has(t));

    const navigational = isNavigationalQuery(query);
    let usable = 0;
    results.forEach((result, index) => {
        if (!navigational && isLikelySiteEntryPage(result.url)) {
            return;
        }
        const docTokens = new Set(docs[index]);
        const hits = requiredTerms.filter((token) => docTokens.has(token)).length;
        const totalQueryHits = uniqueQueryTokens.filter((token) => docTokens.has(token)).length;
        const hitsCore = coreTokens.some((token) => docTokens.has(token));

        // 判定规则：
        // 1. 命中区分性稀有词；
        // 2. 或英文多词查询达到高覆盖率阈值（如 model context protocol 必须 >= 3 词全中）；
        // 3. 或中文/混排技术查询下命中核心实体且总命中 >= 2（如 MCP + 官方/文档，避免中文泛化词导致整页被 df > sqrt(N) 误杀）
        const hasCjkQuery = /[\u4e00-\u9fff]/.test(query);
        const cjkTokens = uniqueQueryTokens.filter((t) => /[\u4e00-\u9fff]/.test(t));
        const hitsCjk = cjkTokens.some((t) => docTokens.has(t));
                if (
            hits >= minHits
            || (uniqueQueryTokens.length >= 3 && totalQueryHits >= highCoverageThreshold)
            || (hasCjkQuery && hasNonGenericCore && hitsCore && hitsCjk)
        ) {
            usable += 1;
        }
    });
    return usable;
}

const FRESHNESS_KEYWORDS = /\b(202[4-9]|latest|recent|newest|today)\b|最新|新版|新特性|升级|版本|\bv\d+\b/i;

/** 时效性平滑微调（P2-8） */
export function computeFreshnessAdjustment(dateStr?: string, queryHasFreshness?: boolean): number {
    if (!queryHasFreshness || !dateStr) {
        return 0;
    }
    const yearMatch = dateStr.match(/\b(20\d{2})\b/);
    if (!yearMatch || !yearMatch[1]) {
        return 0;
    }
    const year = parseInt(yearMatch[1], 10);
    const currentYear = new Date().getFullYear();
    const diff = currentYear - year;

    if (diff <= 0) {
        return 0.12;
    }
    if (diff === 1) {
        return 0.06;
    }
    if (diff === 2) {
        return 0;
    }
    return Math.max(-0.20, -0.04 * (diff - 1));
}

/** 版本与规范路径偏好微调（含日期型规范路径，如 /specification/2026-07-28） */
export function computeVersionPathAdjustment(urlStr: string): number {
    try {
        const url = new URL(urlStr);
        const path = url.pathname.toLowerCase();

        // 1. 规范日期型路径（如 /specification/2026-07-28 vs /specification/2025-03-26）
        const specDateMatch = path.match(/\b(20\d{2})[-_.](\d{2})[-_.](\d{2})\b/);
        if (specDateMatch && (path.includes('spec') || path.includes('draft') || path.includes('standard') || path.includes('protocol'))) {
            const specYear = parseInt(specDateMatch[1]!, 10);
            const currentYear = new Date().getFullYear();
            const yearDiff = currentYear - specYear;
            if (yearDiff <= 0) {
                return 0.18;
            }
            if (yearDiff === 1) {
                return 0.04;
            }
            return Math.max(-0.20, -0.06 * yearDiff);
        }

        // 2. 陈旧/归档路径
        if (
            /\/(legacy|archive|archived|deprecated|obsolete|historic)(\/|$)/.test(path)
            || /\/v0\.[0-9]+(\/|$)/.test(path)
            || /\/(old|older)-version/.test(path)
        ) {
            return -0.12;
        }

        // 3. 最新/活跃/标准路径
        if (
            /\/(latest|current|stable|draft|next|main)(\/|$)/.test(path)
            || /\/v[2-9](\.[0-9]+)?(\/|$)/.test(path)
        ) {
            return 0.08;
        }

        return 0;
    } catch {
        return 0;
    }
}

/** 对融合后的结果做混合重排 */
export function rankSearchResults(
    results: SearchResult[],
    query: string,
    options?: { positionWeight?: number; authorityDomains?: string[] }
): SearchResult[] {
    if (results.length <= 1) {
        return results;
    }

    const queryTokens = tokenizeForRanking(query || '');
    if (queryTokens.length === 0) {
        return results;
    }

    const coreTokens = extractCoreQueryTokens(queryTokens);
    const docs = results.map(getDocTokens);
    const bm25 = bm25Scores(queryTokens, docs);
    const maxBm25 = Math.max(...bm25, 1e-6);

    const applyEntryPagePenalty = !isNavigationalQuery(query);
    const queryHasFreshness = FRESHNESS_KEYWORDS.test(query);

    const positionWeight = options?.positionWeight ?? 0.4;
    const restWeight = 1 - positionWeight;
    const relevanceWeight = restWeight * 0.5;
    const authorityWeight = restWeight * (1 / 3);
    const consensusWeight = restWeight * (1 / 6);

    const useRrf = isRrfFusionEnabled() && results.some((result) => typeof result.rrfScore === 'number');
    const maxRrf = useRrf ? Math.max(...results.map((result) => result.rrfScore ?? 0), 1e-6) : 1;

    const scored = results.map((result, index) => {
        const positionScore = 1 / (1 + index * 0.35);
        const rawBm25 = bm25[index] ?? 0;
        const relevance = rawBm25 / maxBm25;
        const isEntryPage = applyEntryPagePenalty && isLikelySiteEntryPage(result.url);
        const hasQueryMatch = rawBm25 > 0;
        const docTokenSet = new Set(docs[index]);

        // 核心实体硬护栏：必须命中至少一个非泛化的核心实体词；
        // 若对核心实体完全零命中（如 LetPub 命中“最新”但未命中 nodejs），施加强力降权沉底
        const hasCoreMatch = coreTokens.length === 0 || coreTokens.some((t) => docTokenSet.has(t));
        const zeroMatchPenalty = hasCoreMatch ? 0 : 2.0;

        // 标题命中核心实体额外加权：严防仅在正文末尾随口蹭一句热词的无关新闻（如 React 18 发布蹭 Vitest）
        const titleTokens = new Set(tokenizeForRanking(result.title));
        const titleHitsCore = coreTokens.some((t) => titleTokens.has(t));
        const titleCoreBonus = titleHitsCore ? 0.12 : 0;

        const authority = (isEntryPage || !hasQueryMatch) ? 0 : authorityScore(result.url, options?.authorityDomains);
        const consensus = Math.min(result.engineHits ?? 1, 3) / 3;
        const entryPagePenalty = isEntryPage ? 0.25 : 0;
        const freshnessAdjustment = computeFreshnessAdjustment(result.date, queryHasFreshness);
        const versionAdjustment = computeVersionPathAdjustment(result.url);

        const score = (useRrf
            ? 0.45 * ((result.rrfScore ?? 0) / maxRrf)
                + 0.35 * relevance
                + 0.20 * authority
            : positionWeight * positionScore
                + relevanceWeight * relevance
                + authorityWeight * authority
                + consensusWeight * consensus)
            + (result.rankBoost ?? 0)
            + titleCoreBonus
            - entryPagePenalty
            - zeroMatchPenalty
            + freshnessAdjustment
            + versionAdjustment;
        return { result, score, index };
    });

    const sorted = scored
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((entry) => entry.result);

    return applyHostCap(sorted, { authorityDomains: options?.authorityDomains });
}

/** 域名打散与 Host Cap 软降权 */
export function applyHostCap(
    results: SearchResult[],
    options?: { authorityDomains?: string[]; maxPerDomain?: number; maxPerOfficialDomain?: number }
): SearchResult[] {
    if (results.length <= 2) {
        return results;
    }
    const maxPerDomain = options?.maxPerDomain ?? 2;
    const maxPerOfficialDomain = options?.maxPerOfficialDomain ?? 3;
    const domainCounts = new Map<string, number>();
    const selected: SearchResult[] = [];
    const overflow: SearchResult[] = [];

    for (const result of results) {
        const rootDomain = extractRootDomain(result.url);
        const isOfficial = isTier1OfficialDomain(result.url, options?.authorityDomains);
        const cap = isOfficial ? maxPerOfficialDomain : maxPerDomain;
        const currentCount = domainCounts.get(rootDomain) || 0;

        if (currentCount < cap) {
            domainCounts.set(rootDomain, currentCount + 1);
            selected.push(result);
        } else {
            overflow.push(result);
        }
    }

    return [...selected, ...overflow];
}
