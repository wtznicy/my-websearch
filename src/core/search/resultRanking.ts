import { SearchResult } from '../../types.js';
import { config } from '../../config.js';

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

/** 领域权威白名单（文档/代码/百科类站点；可用 SEARCH_AUTHORITY_DOMAINS 追加） */
const DEFAULT_AUTHORITY_DOMAINS = [
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
    'zhihu.com',
    'juejin.cn',
    'segmentfault.com',
    'cnblogs.com',
    'openai.com',
    'anthropic.com',
    'docs.aws.amazon.com'
];

function getAuthorityDomains(): string[] {
    return config.authorityDomains.length > 0
        ? [...DEFAULT_AUTHORITY_DOMAINS, ...config.authorityDomains]
        : DEFAULT_AUTHORITY_DOMAINS;
}

/** 文本分词：英文/数字词（长度 ≥2）+ 中文 bigram */
export function tokenizeForRanking(text: string): string[] {
    const tokens: string[] = [];
    const lower = text.toLowerCase();

    for (const match of lower.matchAll(/[a-z0-9]{2,}/g)) {
        tokens.push(match[0]);
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
function authorityScore(url: string): number {
    let host = '';
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return 0;
    }

    if (getAuthorityDomains().some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return 1;
    }
    // 官方文档域：docs.*、*.github.io（官方文档站）、developer.*、*.readthedocs.io
    // ——实测英文查询失败模式多为"召回到无关仓库/镜像站"，官方文档域加权可压制
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
 * 实测：bing 对含域名的长尾技术 query（如 "github-mcp-server v1.12 release notes"）
 * 会退化成站点首页/登录页，而真正的 release 页反而排后。
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
 * 对融合后的结果做混合重排；查询为空或结果数 ≤1 时原样返回。
 * 只调整顺序，不增删结果、不修改字段。
 */
export function rankSearchResults(
    results: SearchResult[],
    query: string,
    options?: { positionWeight?: number }
): SearchResult[] {
    if (results.length <= 1) {
        return results;
    }

    const queryTokens = tokenizeForRanking(query || '');
    if (queryTokens.length === 0) {
        return results;
    }

    const docs = results.map((result) => tokenizeForRanking(`${result.title} ${result.description}`));
    const bm25 = bm25Scores(queryTokens, docs);
    const maxBm25 = Math.max(...bm25, 1e-6);

    // 非导航类查询下对"站点入口页"降权：惩罚 + 取消权威加分
    // （github.com/ 这类入口页此前因域在白名单里拿满权威分，仍能压过真实结果页）
    const applyEntryPagePenalty = !isNavigationalQuery(query);

    // 权重归一：positionWeight 默认 0.4（单查询内位置分有意义）；
    // 多查询合并后重排传 0——配额顺序不代表排名，位置分应让位给内容信号
    const positionWeight = options?.positionWeight ?? 0.4;
    const restWeight = 1 - positionWeight;
    const relevanceWeight = restWeight * 0.5;
    const authorityWeight = restWeight * (1 / 3);
    const consensusWeight = restWeight * (1 / 6);

    const scored = results.map((result, index) => {
        const positionScore = 1 / (1 + index * 0.35);
        const relevance = bm25[index] / maxBm25;
        const isEntryPage = applyEntryPagePenalty && isLikelySiteEntryPage(result.url);
        const authority = isEntryPage ? 0 : authorityScore(result.url);
        const consensus = Math.min(result.engineHits ?? 1, 3) / 3;
        const entryPagePenalty = isEntryPage ? 0.25 : 0;
        const score = positionWeight * positionScore
            + relevanceWeight * relevance
            + authorityWeight * authority
            + consensusWeight * consensus
            - entryPagePenalty;
        return { result, score, index };
    });

    return scored
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((entry) => entry.result);
}
