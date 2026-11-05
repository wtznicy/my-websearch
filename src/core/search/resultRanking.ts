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
 * 背景：融合排序原本只用 engineHits（跨引擎共识）+ 引擎返回顺序，长尾查询里
 * 标题党/SEO 采集站可能占据前排。这里在融合后加一层混合打分：
 *
 *   score = 0.40 * 位置分（保留搜索引擎自身排名先验，衰减）
 *         + 0.30 * 相关性（BM25：查询词与标题/摘要）
 *         + 0.20 * 权威度（域名白名单 / gov、edu）
 *         + 0.10 * 共识（engineHits）
 *
 * 权重刻意保守：位置分占大头，相关性与权威度只做"明显更优时上浮"的修正，
 * 避免重排把搜索引擎的强信号推翻。
 *
 * 中文用字符 bigram（无分词库依赖），英文用词；全部本地计算。
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
 * 纯数字（如 "2", "3", "2026"）或单个非 CJK 字符（如单个字母）不应单独充当“首词漂移检测”或“可用结果统计”的唯一区分通行证。
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

/** 结果分词缓存（按 SearchResult 对象引用存储，生命周期跟随请求结果生命周期，自动 GC 无内存泄漏） */
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
    // 官方文档域：docs.*、*.github.io（官方文档站）、developer.*、*.readthedocs.io
    if (/^docs\./.test(host) || /\.github\.io$/.test(host) || /^developer\./.test(host) || /\.readthedocs\.io$/.test(host)) {
        return 0.9;
    }
    if (/\.(gov|gov\.cn|edu|edu\.cn|ac\.cn)$/.test(host)) {
        return 0.8;
    }
    // 长域名/多连字符的营销域特征：不给权威分（但仍保留位置与相关性分）
    if (host.length > 30 || (host.match(/-/g) || []).length >= 4) {
        return 0;
    }
    return 0.3;
}

/**
 * 疑似"站点入口页"（首页/登录/注册/索引）：对非导航类查询属低价值结果。
 */
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

/** 导航类查询（查询本身是域名或单一品牌词）：入口页可能就是期望答案，不做惩罚 */
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

/**
 * 每条结果的原始 BM25 相关性分（未归一化，0 = 与查询零词重叠）。
 * 供搜索服务做"可用结果"统计（级联判据）：零重叠 = 词义漂移结果，不应计入。
 */
export function relevanceScores(results: SearchResult[], query: string): number[] {
    const queryTokens = tokenizeForRanking(query || '');
    if (queryTokens.length === 0) {
        return results.map(() => 0);
    }
    const docs = results.map(getDocTokens);
    return bm25Scores(queryTokens, docs);
}

/**
 * 检测结果集是否发生"首词漂移"（First-token drift）：
 * cn.bing HTTP 请求对英文多词查询常退化为只按第一个词匹配。
 */
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

export function countUsableResults(results: SearchResult[], query: string): number {
    const rawQueryTokens = tokenizeForRanking(query || '');
    if (rawQueryTokens.length === 0 || results.length === 0) {
        return results.length;
    }
    const substantive = rawQueryTokens.filter(isSubstantiveRankingToken);
    const queryTokens = substantive.length > 0 ? substantive : rawQueryTokens;

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

    const requiredTerms = discriminativeTerms.length > 0 ? discriminativeTerms : uniqueQueryTokens;
    const minHits = discriminativeTerms.length > 0 ? 1 : Math.min(2, requiredTerms.length);
    const highCoverageThreshold = Math.max(3, Math.ceil(uniqueQueryTokens.length * 0.75));

    const navigational = isNavigationalQuery(query);
    let usable = 0;
    results.forEach((result, index) => {
        if (!navigational && isLikelySiteEntryPage(result.url)) {
            return;
        }
        const docTokens = new Set(docs[index]);
        const hits = requiredTerms.filter((token) => docTokens.has(token)).length;
        const totalQueryHits = uniqueQueryTokens.filter((token) => docTokens.has(token)).length;
        if (hits >= minHits || (uniqueQueryTokens.length >= 3 && totalQueryHits >= highCoverageThreshold)) {
            usable += 1;
        }
    });
    return usable;
}

const FRESHNESS_KEYWORDS = /\b(202[4-9]|latest|recent|newest|today)\b|最新|新版|新特性|升级|版本|\bv\d+\b/i;

/**
 * 时效性平滑微调（P2-8）：
 * 当查询显式包含时效性意图时，按结果发布年份与当前年份的差值进行线性平滑微调。
 * 无日期结果保持 0（不扣分、不硬剔除），避免误杀官方文档。
 */
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
    // 3 年及以上平滑线性衰减，每多 1 年 -0.04，最多 -0.20
    return Math.max(-0.20, -0.04 * (diff - 1));
}

/**
 * 版本与规范路径偏好微调（P2-7）：
 * 针对官方文档与规范站中的旧版倒挂问题（如 /v0.1/ 排在 /latest/ 或 /draft/ 前面），
 * 识别 URL 路径中的版本特征：
 * - 较新/活跃/规范最新路径（/latest/, /current/, /v[2-9]/, /draft/, /stable/）：+0.08
 * - 陈旧/归档路径（/legacy/, /archive/, /archived/, /v0\./, /v1\.0/）：-0.12
 */
export function computeVersionPathAdjustment(urlStr: string): number {
    try {
        const url = new URL(urlStr);
        const path = url.pathname.toLowerCase();

        // 陈旧/归档路径
        if (/\/(legacy|archive|archived|deprecated|obsolete|historic)(\/|$)/.test(path)
            || /\/v0\.[0-9]+(\/|$)/.test(path)
            || /\/(old|older)-version/.test(path)) {
            return -0.12;
        }

        // 最新/活跃/标准路径
        if (/\/(latest|current|stable|draft|next|main)(\/|$)/.test(path)
            || /\/v[2-9](\.[0-9]+)?(\/|$)/.test(path)) {
            return 0.08;
        }

        return 0;
    } catch {
        return 0;
    }
}

const GENERIC_QUERY_TERMS = new Set([
    'configuration', 'config', 'setup', 'install', 'installation',
    'tutorial', 'guide', 'overview', 'docs', 'documentation',
    'download', 'error', 'failed', 'issue', 'problem', 'fix',
    'solve', 'solution', 'how', 'what', 'why', 'use', 'using', 'usage',
    '配置', '安装', '教程', '指南', '文档', '下载', '报错',
    '错误', '解决', '怎么', '什么', '如何', '使用', '用法', '简介', '概述', '原理'
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
 * 对融合后的结果做混合重排；查询为空或结果数 ≤1 时原样返回。
 * 只调整顺序，不增删结果、不修改字段。
 */
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
        // P1-5：相关性硬护栏：若对 query 的核心 token 零命中，强力惩罚降至尾部，严防噪声霸榜
        const hasCoreMatch = coreTokens.length === 0 || coreTokens.some((t) => docTokenSet.has(t));
        const zeroMatchPenalty = hasCoreMatch ? 0 : 2.0;
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

/**
 * 域名打散与 Host Cap 软降权：
 * 同一注册域在 Top 结果中最多保留 2 条（Tier 1 官方文档域最多 3 条），超出的条目打散降权到末尾，
 * 避免单一垂直社区（如掘金/CSDN）或 SEO 站群包揽前排，同时不硬删数据。
 */
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
