export interface BriefResultItem {
    title: string;
    url: string;
    description?: string;
    date?: string;
    publishedAt?: string;
    source?: string;
    engine?: string;
    fullContent?: string;
}

export interface RenderSearchBriefOptions {
    query: string | string[];
    engines: string[];
    outcome: string;
    totalResults: number;
    results: BriefResultItem[];
    directAnswer?: string;
    warnings?: string[];
    partialFailures?: Array<{ engine: string; message: string }>;
}

/**
 * 将带 fetchTop 的检索结果直接渲染为层级分明、免二次转义的结构化 Markdown 研报。
 */
export function renderSearchBriefMarkdown(options: RenderSearchBriefOptions): string {
    const { query, engines, outcome, totalResults, results, directAnswer, warnings, partialFailures } = options;
    const queryDisplay = Array.isArray(query) ? query.join(' | ') : query;

    const lines: string[] = [];
    lines.push(`# 检索研报: ${queryDisplay}`);

    const metaParts = [
        `引擎: ${engines.join(', ') || 'auto'}`,
        `来源: ${totalResults} 条`,
        `状态: ${outcome}`
    ];
    lines.push(`> ${metaParts.join(' · ')}\n`);

    if (directAnswer && directAnswer.trim()) {
        lines.push('## 概览解答 (Direct Answer)\n');
        lines.push(directAnswer.trim());
        lines.push('\n---\n');
    }

    // 分离出含有全文的 top 文档和仅有摘要的普通文档
    const topArticles = results.filter((r) => Boolean(r.fullContent && r.fullContent.trim()));
    const otherResults = results.filter((r) => !r.fullContent || !r.fullContent.trim());

    // 1. 来源清单
    lines.push('## 来源清单 (Sources)');
    results.forEach((r, idx) => {
        const num = idx + 1;
        const dateVal = r.publishedAt || r.date;
        const dateStr = dateVal ? ` (${dateVal})` : '';
        const sourceStr = r.source ? ` · *${r.source}*` : '';
        lines.push(`${num}. [${r.title || 'Untitled'}](${r.url})${sourceStr}${dateStr}`);
    });
    lines.push('');

    // 2. 核心全文 (Top Documents)
    if (topArticles.length > 0) {
        lines.push('---\n');
        lines.push('## 核心正文 (Top Documents)\n');

        topArticles.forEach((article, idx) => {
            const num = idx + 1;
            lines.push(`### [${num}] ${article.title || 'Untitled'}`);
            const metaInfo: string[] = [`URL: ${article.url}`];
            if (article.source) metaInfo.push(`来源: ${article.source}`);
            const dateVal = article.publishedAt || article.date;
            if (dateVal) metaInfo.push(`发布日期: ${dateVal}`);
            lines.push(`> ${metaInfo.join(' | ')}\n`);
            lines.push(article.fullContent!.trim());
            lines.push('\n---\n');
        });
    }

    // 3. 其他参考结果 (若存在未拉取全文的结果)
    if (topArticles.length > 0 && otherResults.length > 0) {
        lines.push('## 补充参考条目 (Additional Results)\n');
        otherResults.forEach((r, idx) => {
            const num = topArticles.length + idx + 1;
            const dateVal = r.publishedAt || r.date;
            const dateStr = dateVal ? ` [${dateVal}]` : '';
            const sourceStr = r.source ? ` (${r.source})` : '';
            lines.push(`- **[${num}] [${r.title || 'Untitled'}](${r.url})**${sourceStr}${dateStr}`);
            if (r.description && r.description.trim()) {
                lines.push(`  ${r.description.trim()}`);
            }
        });
        lines.push('');
    }

    // 4. 异常提示（若有降级）
    if (partialFailures && partialFailures.length > 0) {
        lines.push('\n> [!NOTE]');
        lines.push(`> 部分引擎未响应: ${partialFailures.map((f) => `${f.engine} (${f.message})`).join('; ')}`);
    }

    if (warnings && warnings.length > 0) {
        lines.push(`> 提示: ${warnings.join('; ')}`);
    }

    return lines.join('\n').trim();
}
