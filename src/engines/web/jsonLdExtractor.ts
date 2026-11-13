/**
 * 结构化 JSON-LD 正文优先提取器。
 *
 * 识别 Schema.org 高价值结构化实体（FAQPage / QAPage / HowTo / Article），
 * 在走 Readability 之前优先提取，跳过所有 HTML 布局与侧边栏噪音。
 *
 * 判定与门禁策略：
 * 1. FAQPage / QAPage：只要包含 >= 1 个有效问答对即提取；
 * 2. HowTo：只要包含 >= 1 个步骤即提取；
 * 3. Article / TechArticle / NewsArticle / BlogPosting：必须提供 articleBody 且长度 >= 500 字符。
 *    （避免提取简短摘要而丢弃正文，短内容一律回退 Readability）。
 */

export interface JsonLdContentResult {
    type: 'faq' | 'howto' | 'article';
    title?: string;
    markdown: string;
}

function cleanHtmlInJsonLd(text: string): string {
    return text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function walkEntities(obj: unknown, callback: (record: Record<string, unknown>, typeStr: string) => void): void {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            walkEntities(item, callback);
        }
        return;
    }

    const record = obj as Record<string, unknown>;
    if (record['@graph'] && Array.isArray(record['@graph'])) {
        for (const item of record['@graph']) {
            walkEntities(item, callback);
        }
    }

    const rawType = record['@type'];
    if (typeof rawType === 'string') {
        callback(record, rawType.toLowerCase().replace(/^https?:\/\/schema\.org\//i, ''));
    } else if (Array.isArray(rawType)) {
        for (const t of rawType) {
            if (typeof t === 'string') {
                callback(record, t.toLowerCase().replace(/^https?:\/\/schema\.org\//i, ''));
            }
        }
    }
}

/**
 * 尝试从 HTML 中提取 Schema.org JSON-LD 高信噪比内容
 */
export function extractContentFromJsonLd(html: string): JsonLdContentResult | null {
    if (!html || !html.includes('application/ld+json')) {
        return null;
    }

    const scriptRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    const faqEntities: Array<Record<string, unknown>> = [];
    const howToEntities: Array<Record<string, unknown>> = [];
    const articleEntities: Array<Record<string, unknown>> = [];

    while ((match = scriptRegex.exec(html)) !== null) {
        const rawContent = match[1]?.trim();
        if (!rawContent) continue;
        try {
            const parsed = JSON.parse(rawContent);
            walkEntities(parsed, (record, type) => {
                if (type === 'faqpage' || type === 'qapage') {
                    faqEntities.push(record);
                } else if (type === 'howto') {
                    howToEntities.push(record);
                } else if (
                    type === 'article' ||
                    type === 'techarticle' ||
                    type === 'newsarticle' ||
                    type === 'blogposting' ||
                    type === 'scholarlyarticle'
                ) {
                    articleEntities.push(record);
                }
            });
        } catch {
            // ignore malformed JSON-LD chunks
        }
    }

    // 1. 优先提取 FAQPage / QAPage（问答高密度内容）
    for (const faq of faqEntities) {
        const mainEntity = faq['mainEntity'];
        const questions: Array<{ q: string; a: string }> = [];

        const checkQuestion = (item: unknown) => {
            if (!item || typeof item !== 'object') return;
            const qRecord = item as Record<string, unknown>;
            const questionText = typeof qRecord['name'] === 'string' ? qRecord['name'].trim() : '';
            if (!questionText) return;

            let answerText = '';
            const accepted = qRecord['acceptedAnswer'] as Record<string, unknown> | undefined;
            const suggested = qRecord['suggestedAnswer'] as Record<string, unknown> | undefined;
            const targetAnswer = accepted || suggested;

            if (targetAnswer && typeof targetAnswer['text'] === 'string') {
                answerText = targetAnswer['text'].trim();
            } else if (typeof qRecord['text'] === 'string') {
                answerText = qRecord['text'].trim();
            }

            if (questionText && answerText) {
                questions.push({
                    q: cleanHtmlInJsonLd(questionText),
                    a: cleanHtmlInJsonLd(answerText)
                });
            }
        };

        if (Array.isArray(mainEntity)) {
            for (const item of mainEntity) {
                checkQuestion(item);
            }
        } else if (mainEntity && typeof mainEntity === 'object') {
            checkQuestion(mainEntity);
        }

        if (questions.length > 0) {
            const title = typeof faq['name'] === 'string' ? faq['name'].trim() : 'Frequently Asked Questions';
            const lines: string[] = [`# ${title}\n`];
            for (let i = 0; i < questions.length; i++) {
                const item = questions[i]!;
                lines.push(`### Q: ${item.q}\n\n${item.a}\n`);
            }
            return {
                type: 'faq',
                title,
                markdown: lines.join('\n').trim()
            };
        }
    }

    // 2. 提取 HowTo 操作步骤
    for (const howTo of howToEntities) {
        const stepEntity = howTo['step'];
        const steps: Array<{ name?: string; text: string }> = [];

        const checkStep = (item: unknown) => {
            if (!item || typeof item !== 'object') return;
            const sRecord = item as Record<string, unknown>;
            const text = typeof sRecord['text'] === 'string'
                ? sRecord['text'].trim()
                : (typeof sRecord['description'] === 'string' ? sRecord['description'].trim() : '');
            const name = typeof sRecord['name'] === 'string' ? sRecord['name'].trim() : undefined;
            if (text) {
                steps.push({
                    name: name ? cleanHtmlInJsonLd(name) : undefined,
                    text: cleanHtmlInJsonLd(text)
                });
            }
        };

        if (Array.isArray(stepEntity)) {
            for (const item of stepEntity) {
                checkStep(item);
            }
        } else if (stepEntity && typeof stepEntity === 'object') {
            checkStep(stepEntity);
        }

        if (steps.length > 0) {
            const title = typeof howTo['name'] === 'string' ? howTo['name'].trim() : 'Instructions';
            const desc = typeof howTo['description'] === 'string' ? cleanHtmlInJsonLd(howTo['description']) : '';
            const lines: string[] = [`# ${title}\n`];
            if (desc) {
                lines.push(`${desc}\n`);
            }
            lines.push('## Steps\n');
            for (let i = 0; i < steps.length; i++) {
                const s = steps[i]!;
                if (s.name) {
                    lines.push(`${i + 1}. **${s.name}**\n   ${s.text}\n`);
                } else {
                    lines.push(`${i + 1}. ${s.text}\n`);
                }
            }
            return {
                type: 'howto',
                title,
                markdown: lines.join('\n').trim()
            };
        }
    }

    // 3. 提取 Article / TechArticle（仅在 articleBody 充沛 >= 500 字符时采纳）
    for (const art of articleEntities) {
        const articleBody = typeof art['articleBody'] === 'string' ? art['articleBody'].trim() : '';
        if (articleBody.length >= 500) {
            const headline = typeof art['headline'] === 'string' ? art['headline'].trim() : (typeof art['name'] === 'string' ? art['name'].trim() : '');
            const author = art['author'] && typeof (art['author'] as Record<string, unknown>)['name'] === 'string'
                ? String((art['author'] as Record<string, unknown>)['name'])
                : (typeof art['author'] === 'string' ? art['author'] : '');

            const lines: string[] = [];
            if (headline) {
                lines.push(`# ${headline}\n`);
            }
            if (author) {
                lines.push(`*By ${author}*\n`);
            }
            lines.push(cleanHtmlInJsonLd(articleBody));

            return {
                type: 'article',
                title: headline || undefined,
                markdown: lines.join('\n').trim()
            };
        }
    }

    return null;
}
