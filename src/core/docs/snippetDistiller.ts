import { Context7CodeSnippet, Context7InfoSnippet } from '../../engines/context7/context7.js';
import { scoreBlocks, tokenize } from '../../utils/bm25.js';

export interface DistillOptions {
    /** 用户的关注主题/方法名/关键词（如 "middleware", "useMemo", "install"） */
    query?: string;
    /** 最大保留的代码片段数量，默认 5 */
    limit?: number;
}

export interface DistilledDocumentation {
    codeSnippets: Context7CodeSnippet[];
    infoSnippets: Context7InfoSnippet[];
    /** 清洗后的一句话概览（若有） */
    overview?: string;
}

/**
 * 剔除 README 中的样板噪音：
 * - 徽章栏（Shields badges: [![...](...)]）
 * - HTML 居中图片/徽章墙
 * - 纯目录（Table of Contents 锚点列表）
 * - 尾部无关样板（Sponsors, Backers, Contributors, Stargazers, License, Donation）
 */
export function stripReadmeBoilerplate(markdown: string): string {
    if (!markdown || !markdown.trim()) {
        return '';
    }

    let cleaned = markdown.replace(/\r\n/g, '\n');

    // 1. 剔除尾部赞助、贡献、许可证等章节（从该标题一直到文章末尾）
    cleaned = cleaned.replace(
        /\n#{1,3}\s+(?:sponsors?|backers?|donations?|license|licence|contributing|contributors|special thanks|community)[\s\S]*$/i,
        ''
    );

    // 2. 剔除 HTML 居中排版的 Logo / 徽章区（如 <p align="center">...<img ...>...</p>）
    cleaned = cleaned.replace(/<p[^>]*align=["']center["'][^>]*>[\s\S]*?<\/p>/gi, '');
    cleaned = cleaned.replace(/<div[^>]*align=["']center["'][^>]*>[\s\S]*?<\/div>/gi, '');

    // 3. 剔除 Markdown 链接徽章 [![...](...)](...)
    cleaned = cleaned.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '');
    // 单独的图片徽章 ![![...](...)] 或 ![...](...)
    cleaned = cleaned.replace(/!\[(?:badge|build|npm|downloads|stars|license|coverage|ci)[^\]]*\]\([^)]*\)/gi, '');

    // 4. 剔除 Table of Contents 纯链接目录段落
    cleaned = cleaned.replace(/\n#{1,3}\s+Table of [Cc]ontents[\s\S]*?(?=\n#{1,3}\s+|$)/i, '');

    return cleaned.trim();
}

/**
 * 结构化解析 Markdown：
 * 将 Markdown 切分为带标题归属的说明文本与代码块，提纯成 CodeSnippets 与 InfoSnippets。
 */
export function distillMarkdownSnippets(markdown: string, options: DistillOptions = {}): DistilledDocumentation {
    const rawCleaned = stripReadmeBoilerplate(markdown);
    if (!rawCleaned) {
        return { codeSnippets: [], infoSnippets: [] };
    }

    const maxLimit = options.limit && options.limit > 0 ? options.limit : 5;
    const query = options.query?.trim();

    const lines = rawCleaned.split('\n');
    const rawCodeSnippets: Context7CodeSnippet[] = [];
    const rawInfoSnippets: Context7InfoSnippet[] = [];

    let currentHeading = 'Overview';
    let currentSubHeading = '';
    let recentParagraphLines: string[] = [];
    let inCodeBlock = false;
    let codeLanguage = '';
    let codeBuffer: string[] = [];
    let overviewCaptured = false;
    let overviewText = '';

    const flushCodeBlock = (): void => {
        const codeText = codeBuffer.join('\n').trim();
        codeBuffer = [];
        inCodeBlock = false;

        if (!codeText) {
            return;
        }

        // 过滤极其微小琐碎的单行命令，如仅有 "npm install" 等，优先提取真正的库用法
        const description = recentParagraphLines.join(' ').trim();
        recentParagraphLines = [];

        rawCodeSnippets.push({
            pageTitle: currentHeading,
            codeTitle: currentSubHeading || currentHeading,
            codeDescription: description || undefined,
            codeList: [{
                code: codeText,
                language: codeLanguage || undefined
            }]
        });
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();

        // 围栏代码块起始/结束
        const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
        if (fenceMatch) {
            if (inCodeBlock) {
                flushCodeBlock();
            } else {
                inCodeBlock = true;
                codeLanguage = (fenceMatch[2] ?? '').trim().toLowerCase();
            }
            continue;
        }

        if (inCodeBlock) {
            codeBuffer.push(line);
            continue;
        }

        // 标题行检测
        const headingMatch = line.match(/^ {0,3}(#{1,4})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1]?.length ?? 2;
            const headingText = headingMatch[2]!.replace(/[#*`_]/g, '').trim();

            if (level === 1) {
                // 一级标题（库名），重置为 Overview
                currentHeading = 'Overview';
                currentSubHeading = '';
            } else if (level === 2) {
                currentHeading = headingText;
                currentSubHeading = '';
            } else {
                currentSubHeading = headingText;
            }
            recentParagraphLines = [];
            continue;
        }

        // 正文段落
        if (trimmed) {
            recentParagraphLines.push(trimmed);
            // 抓取开篇第一段作为 overview
            if (!overviewCaptured && recentParagraphLines.length >= 1 && currentHeading === 'Overview') {
                overviewText = trimmed;
                overviewCaptured = true;
            }
        } else {
            // 空行：若累积了说明段落，且篇幅适中，存为候选 infoSnippet
            if (recentParagraphLines.length > 0) {
                const text = recentParagraphLines.join(' ').trim();
                // 仅保留有实质说明意义的段落
                if (text.length > 40 && !text.startsWith('http') && !text.startsWith('<')) {
                    rawInfoSnippets.push({
                        title: currentSubHeading ? `${currentHeading} - ${currentSubHeading}` : currentHeading,
                        content: text
                    });
                }
            }
            recentParagraphLines = [];
        }
    }

    if (inCodeBlock) {
        flushCodeBlock();
    }

    // 若没有指定 query：进行启发式精选（优先保留常用场景：Quick Start, Usage, Examples, Basic 等）
    if (!query) {
        const prioritized = prioritizeSnippetsByDefault(rawCodeSnippets);
        return {
            codeSnippets: prioritized.slice(0, maxLimit),
            infoSnippets: rawInfoSnippets.slice(0, 3),
            overview: overviewText || undefined
        };
    }

    // 若指定了 query：使用 BM25 算法对每个 Snippet 算出与 query 的相关性得分
    const scoredSnippets = rankSnippetsByQuery(rawCodeSnippets, query);
    const scoredInfoSnippets = rankInfoSnippetsByQuery(rawInfoSnippets, query);

    return {
        codeSnippets: scoredSnippets.slice(0, maxLimit),
        infoSnippets: scoredInfoSnippets.slice(0, 3),
        overview: overviewText || undefined
    };
}

/**
 * 当未指定 query 时，优先保留核心使用示例章节
 */
function prioritizeSnippetsByDefault(snippets: Context7CodeSnippet[]): Context7CodeSnippet[] {
    const HIGH_PRIORITY_RE = /quick\s*start|usage|getting\s*started|example|basic|overview|guide/i;
    const LOW_PRIORITY_RE = /install|contributing|test|badge|config\b/i;

    const high: Context7CodeSnippet[] = [];
    const normal: Context7CodeSnippet[] = [];
    const low: Context7CodeSnippet[] = [];

    for (const item of snippets) {
        const title = `${item.pageTitle ?? ''} ${item.codeTitle ?? ''}`;
        if (HIGH_PRIORITY_RE.test(title)) {
            high.push(item);
        } else if (LOW_PRIORITY_RE.test(title)) {
            low.push(item);
        } else {
            normal.push(item);
        }
    }

    return [...high, ...normal, ...low];
}

/**
 * 使用纯本地 BM25 计算代码片段与 query 的相关性并排序
 */
function rankSnippetsByQuery(snippets: Context7CodeSnippet[], query: string): Context7CodeSnippet[] {
    if (snippets.length === 0) return [];

    const queryTokens = tokenize(query);
    const queryLower = query.toLowerCase();

    // 构造每块的代表性文本（标题权重更高）
    const docTexts = snippets.map((s) => {
        const codeCombined = (s.codeList ?? []).map((c) => c.code).join('\n');
        return `${s.pageTitle ?? ''} ${s.codeTitle ?? ''} ${s.pageTitle ?? ''}\n${s.codeDescription ?? ''}\n${codeCombined}`;
    });

    const scores = scoreBlocks(docTexts, queryTokens);

    const indexed = snippets.map((snippet, index) => {
        let score = scores[index] ?? 0;
        const textLower = (docTexts[index] ?? '').toLowerCase();

        // 完整词汇字面命中加成
        if (textLower.includes(queryLower)) {
            score += 100;
        }

        // 标题命中特权加成
        const titleLower = `${snippet.pageTitle ?? ''} ${snippet.codeTitle ?? ''}`.toLowerCase();
        if (titleLower.includes(queryLower)) {
            score += 200;
        }

        return { snippet, score };
    });

    indexed.sort((a, b) => b.score - a.score);
    return indexed.filter((item) => item.score > 0 || snippets.length <= 3).map((item) => item.snippet);
}

/**
 * 针对说明段落使用 BM25 排序
 */
function rankInfoSnippetsByQuery(snippets: Context7InfoSnippet[], query: string): Context7InfoSnippet[] {
    if (snippets.length === 0) return [];
    const queryTokens = tokenize(query);
    const docTexts = snippets.map((s) => `${s.title ?? ''}\n${s.content}`);
    const scores = scoreBlocks(docTexts, queryTokens);

    const indexed = snippets.map((snippet, index) => ({
        snippet,
        score: scores[index] ?? 0
    }));

    indexed.sort((a, b) => b.score - a.score);
    return indexed.filter((item) => item.score > 0).map((item) => item.snippet);
}
