import * as cheerio from 'cheerio';

export interface SitePurificationResult {
    title?: string;
    html: string;
    text: string;
    author?: string;
    siteName?: string;
}

/**
 * 微信公众号文章 (mp.weixin.qq.com) 专用正文提纯器：
 * - 提取 #activity-name 标题与 #js_name 公众号作者
 * - 提取 #js_content 正文容器
 * - 还原微信图片懒加载 data-src 为标准 src
 * - 剔除底部二维码、点赞打赏、关注引导等冗余噪音
 */
export function purifyWeChatArticle(html: string): SitePurificationResult | undefined {
    const $ = cheerio.load(html);
    const container = $('#js_content');
    if (container.length === 0) {
        return undefined;
    }

    const title = $('#activity-name').text().trim() ||
        $('meta[property="og:title"]').attr('content')?.trim() ||
        $('title').text().trim();

    const author = $('#js_name').text().trim() ||
        $('.profile_nickname').text().trim() ||
        $('meta[name="author"]').attr('content')?.trim() ||
        undefined;

    // 剔除干扰元素
    container.find('script, style, noscript, .qr_code_pc, .reward_area, .rich_media_tool, #js_toobar3').remove();

    // 还原微信公众号懒加载图片 data-src -> src
    container.find('img').each((_, el) => {
        const dataSrc = $(el).attr('data-src');
        if (dataSrc) {
            $(el).attr('src', dataSrc);
            $(el).removeAttr('data-src');
        }
    });

    const cleanHtml = container.html()?.trim() || '';
    const cleanText = container.text().replace(/\s+/g, ' ').trim();

    return {
        title,
        html: cleanHtml,
        text: cleanText,
        author,
        siteName: author ? `微信公众号: ${author}` : '微信公众号'
    };
}

/**
 * Stack Overflow 问答页 (stackoverflow.com/questions/\d+) 专用正文提纯器：
 * - 提取问题标题与主楼正文
 * - 提取采纳答案 (Accepted Answer)
 * - 提取前 2 个最高赞答案 (剥离侧边栏、用户卡片、广告)
 */
export function purifyStackOverflowQuestion(html: string): SitePurificationResult | undefined {
    const $ = cheerio.load(html);
    const questionHeader = $('#question-header h1 a').first();
    const title = questionHeader.text().trim() || $('h1[itemprop="name"]').text().trim() || $('title').text().trim();

    const questionBody = $('#question .js-post-body').first();
    if (questionBody.length === 0) {
        return undefined;
    }

    const questionHtml = questionBody.html()?.trim() || '';
    const parts: string[] = [];
    parts.push(`<h1>${title}</h1>`);
    parts.push(`<h2>Question</h2>\n<div>${questionHtml}</div>`);

    // 采纳答案
    const acceptedAnswer = $('.answer.accepted-answer').first();
    if (acceptedAnswer.length > 0) {
        const score = acceptedAnswer.find('.js-vote-count').text().trim();
        const ansBody = acceptedAnswer.find('.js-post-body').html()?.trim() || '';
        parts.push(`<h2>Accepted Answer (Score: ${score})</h2>\n<div>${ansBody}</div>`);
    }

    // 其余高赞回答（排除采纳答案，取前 2 个）
    const otherAnswers = $('.answer:not(.accepted-answer)').toArray().slice(0, 2);
    for (const ansEl of otherAnswers) {
        const $ans = $(ansEl);
        const score = $ans.find('.js-vote-count').text().trim();
        const ansBody = $ans.find('.js-post-body').html()?.trim() || '';
        if (ansBody) {
            parts.push(`<h2>Other High-Voted Answer (Score: ${score})</h2>\n<div>${ansBody}</div>`);
        }
    }

    const combinedHtml = parts.join('\n\n');
    const combinedText = cheerio.load(combinedHtml).root().text().replace(/\s+/g, ' ').trim();

    return {
        title,
        html: combinedHtml,
        text: combinedText,
        siteName: 'Stack Overflow'
    };
}

/**
 * 专用站点嗅探分发入口：命中特定技术/文章站点时返回提纯结果，否则返回 undefined
 */
export function purifySiteContent(url: string, html: string): SitePurificationResult | undefined {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname;

        if (host === 'mp.weixin.qq.com') {
            return purifyWeChatArticle(html);
        }

        if (host.includes('stackoverflow.com') && /^\/questions\/\d+/.test(pathname)) {
            return purifyStackOverflowQuestion(html);
        }

        return undefined;
    } catch {
        return undefined;
    }
}
