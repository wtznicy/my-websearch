import * as cheerio from 'cheerio';
import { extractArticleTitle, stripPromotionSections, isCsdnSoft404, normalizeExtractedText } from '../csdn/fetchCsdnArticle.js';
import { extractJuejinTitle } from '../juejin/fetchJuejinArticle.js';

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
 * CSDN 博客文章 (blog.csdn.net/.../article/details/...) 专用正文提纯器：
 * - 提取文章标题与博主作者
 * - 提取 #content_views / .article_content 容器
 * - 剔除工具栏、打赏区、推荐博文及底部推广牛皮癣
 */
export function purifyCsdnArticle(html: string): SitePurificationResult | undefined {
    if (isCsdnSoft404(html)) {
        return undefined;
    }

    const $ = cheerio.load(html);
    const title = extractArticleTitle(html);
    const author = $('.follow-nickName').first().text().trim() ||
        $('a.user-name').first().text().trim() ||
        $('meta[name="author"]').attr('content')?.trim() ||
        undefined;

    const CSDN_CONTENT_SELECTORS = [
        '#content_views',
        '.article_content',
        '.htmledit_views',
        '#article_content',
        '.blog-content-box',
        'article'
    ];

    let container: ReturnType<typeof $> | null = null;
    for (const selector of CSDN_CONTENT_SELECTORS) {
        const found = $(selector).first();
        if (found.length > 0 && found.text().trim().length > 0) {
            container = found;
            break;
        }
    }

    if (!container || container.length === 0) {
        return undefined;
    }

    container.find('script, style, noscript, .recommend-box, .toolbar, .reward-user-box, .blog-footer-bottom, .article-info-box, .user-card-box, .blog-expert-recommend-box, .personal-info-box, .card-user-info, .profile-intro, .more-toolbox, .column-group').remove();

    const rawText = normalizeExtractedText(container.text());
    const cleanText = stripPromotionSections(rawText);
    if (isCsdnSoft404(html, cleanText)) {
        return undefined;
    }

    const cleanHtml = container.html()?.trim() || '';

    return {
        title: title || undefined,
        html: cleanHtml,
        text: cleanText,
        author,
        siteName: author ? `CSDN博客: ${author}` : 'CSDN博客'
    };
}

/**
 * 稀土掘金文章 (juejin.cn/post/...) 专用正文提纯器：
 * - 提取文章标题与作者
 * - 提取 .markdown-body / .article-content 正文容器
 * - 剔除代码块行号、复制按钮、推荐等噪音
 */
export function purifyJuejinArticle(html: string): SitePurificationResult | undefined {
    const $ = cheerio.load(html);
    const title = extractJuejinTitle(html);
    const author = $('.author-name .name').text().trim() ||
        $('.author-name').text().trim() ||
        $('meta[name="author"]').attr('content')?.trim() ||
        undefined;

    const selectors = [
        '.markdown-body',
        '.article-content',
        '.content',
        '[data-v-md-editor-preview]',
        '.bytemd-preview',
        '.article-area .content'
    ];

    let container: ReturnType<typeof $> | null = null;
    for (const sel of selectors) {
        const found = $(sel).first();
        if (found.length > 0 && found.text().trim().length > 0) {
            container = found;
            break;
        }
    }

    if (!container || container.length === 0) {
        return undefined;
    }

    container.find('script, style, noscript, .code-block-extension, .hljs-ln-numbers, .copy-code-btn').remove();

    const cleanHtml = container.html()?.trim() || '';
    const cleanText = container.text().replace(/\s+/g, ' ').trim();

    return {
        title: title || undefined,
        html: cleanHtml,
        text: cleanText,
        author,
        siteName: author ? `稀土掘金: ${author}` : '稀土掘金'
    };
}

/**
 * 知乎文章/回答专用正文提纯器：
 * - 覆盖 zhuanlan.zhihu.com/p/<id> 与 zhihu.com/question/<id>/answer/<id>
 * - 提取标题、作者与 RichText 正文
 * - 剔除登录弹窗、推荐流、评论区、操作栏
 */
export function purifyZhihuContent(html: string): SitePurificationResult | undefined {
    const $ = cheerio.load(html);
    const selectors = [
        '.Post-RichText',
        '.RichText.ztext',
        '.RichContent-inner',
        '.QuestionAnswer-content'
    ];

    let container: ReturnType<typeof $> | null = null;
    for (const selector of selectors) {
        const found = $(selector).first();
        if (found.length > 0 && found.text().trim().length > 0) {
            container = found;
            break;
        }
    }
    if (!container || container.length === 0) {
        return undefined;
    }

    const title = $('h1.QuestionHeader-title').first().text().trim() ||
        $('.Post-Title').first().text().trim() ||
        $('h1').first().text().trim() ||
        $('meta[property="og:title"]').attr('content')?.trim() ||
        undefined;
    const author = $('.AuthorInfo-name').first().text().trim() ||
        $('.UserLink-link').first().text().trim() ||
        $('meta[name="author"]').attr('content')?.trim() ||
        undefined;

    container.find('script, style, noscript, .ContentItem-actions, .RichContent-actions, .Recommendations, .Pc-feedAd-container, .Modal, .LoginModal, .CornerButtons, .Comments-container, .CommentList, .Reward').remove();

    const cleanHtml = container.html()?.trim() || '';
    const cleanText = container.text().replace(/\s+/g, ' ').trim();
    if (!cleanText) {
        return undefined;
    }

    return {
        title,
        html: cleanHtml,
        text: cleanText,
        author,
        siteName: author ? `知乎: ${author}` : '知乎'
    };
}

/**
 * 博客园文章 (cnblogs.com/*\/p/*.html) 专用正文提纯器：
 * - 提取 #cnblogs_post_body 正文
 * - 剔除文章底部版权、评论、推荐与登录提示
 */
export function purifyCnblogsArticle(html: string): SitePurificationResult | undefined {
    const $ = cheerio.load(html);
    const selectors = ['#cnblogs_post_body', '.postBody', '.blogpost-body'];

    let container: ReturnType<typeof $> | null = null;
    for (const selector of selectors) {
        const found = $(selector).first();
        if (found.length > 0 && found.text().trim().length > 0) {
            container = found;
            break;
        }
    }
    if (!container || container.length === 0) {
        return undefined;
    }

    const title = $('#cb_post_title_url').first().text().trim() ||
        $('h1.postTitle').first().text().trim() ||
        $('h1').first().text().trim() ||
        $('meta[property="og:title"]').attr('content')?.trim() ||
        undefined;
    const author = $('#post_author').first().text().trim() ||
        $('.postDesc a').first().text().trim() ||
        $('meta[name="author"]').attr('content')?.trim() ||
        undefined;

    container.find('script, style, noscript, .postDesc, #blog_post_info, .clear, .post-foot, .cnblogs_code_toolbar, .recommend, .commentform, #commentform').remove();

    const cleanHtml = container.html()?.trim() || '';
    const cleanText = container.text().replace(/\s+/g, ' ').trim();
    if (!cleanText) {
        return undefined;
    }

    return {
        title,
        html: cleanHtml,
        text: cleanText,
        author,
        siteName: author ? `博客园: ${author}` : '博客园'
    };
}

/**
 * Reddit 帖子专用提纯器（old.reddit / shreddit）：
 * - 提取标题、作者、正文
 * - 提取高赞评论并按分数排序（最多 10 条），保留缩进层级
 * - 剔除侧栏、广告、推荐流与登录提示
 */
export function purifyRedditThread(html: string): SitePurificationResult | undefined {
    const $ = cheerio.load(html);
    $('script, style, noscript, .side, .promoted, .ad, shreddit-ad, .recommended, .login-modal').remove();

    const shredditPost = $('shreddit-post').first();
    const oldPost = $('div.thing.link, #siteTable .thing').first();
    const title = shredditPost.attr('post-title')?.trim()
        || oldPost.find('a.title').first().text().trim()
        || $('meta[property="og:title"]').attr('content')?.trim()
        || $('h1').first().text().trim()
        || undefined;
    if (!title) {
        return undefined;
    }

    const author = shredditPost.attr('author')?.trim()
        || oldPost.find('a.author').first().text().trim()
        || undefined;
    const postScore = shredditPost.attr('score')?.trim()
        || oldPost.find('.score.unvoted').first().text().trim()
        || undefined;

    const postBody = shredditPost.find('[slot="text-body"], .text-body').first().text().trim()
        || oldPost.find('.expando .usertext-body .md, .usertext-body .md').first().text().trim()
        || '';

    const comments: Array<{ author: string; score: number; depth: number; body: string }> = [];
    const commentNodes = $('shreddit-comment').length > 0
        ? $('shreddit-comment').toArray()
        : $('.commentarea .thing.comment').toArray();

    for (const node of commentNodes) {
        const element = $(node);
        const isShreddit = node.tagName.toLowerCase() === 'shreddit-comment';
        const body = (isShreddit
            ? element.find('[slot="comment"]').first().text()
            : element.find('.usertext-body .md').first().text()).replace(/\s+/g, ' ').trim();
        if (!body) continue;
        const rawScore = isShreddit ? element.attr('score') : element.find('.score.unvoted').first().text();
        const score = Number(String(rawScore ?? '').replace(/[^\d-]/g, '')) || 0;
        const depth = Number(isShreddit ? element.attr('depth') : element.attr('data-depth')) || 0;
        const commentAuthor = (isShreddit ? element.attr('author') : element.find('a.author').first().text())?.trim() || 'anonymous';
        comments.push({ author: commentAuthor, score, depth, body });
    }

    comments.sort((left, right) => right.score - left.score);
    const topComments = comments.slice(0, 10);

    const textParts = [
        `# ${title}`,
        [author ? `u/${author}` : '', postScore ? `score ${postScore}` : ''].filter(Boolean).join(' · '),
        postBody,
        topComments.length > 0 ? '## Top comments' : '',
        ...topComments.map((comment) => `${'  '.repeat(Math.min(comment.depth, 5))}[${comment.score}] u/${comment.author}: ${comment.body}`)
    ].filter(Boolean);

    const escapeHtml = (value: string) => value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const postHtml = shredditPost.length > 0 ? shredditPost.html() ?? '' : oldPost.html() ?? '';
    const commentsHtml = topComments.length > 0
        ? `<h2>Top comments</h2>${topComments.map((comment) => `<p>[${comment.score}] u/${escapeHtml(comment.author)}: ${escapeHtml(comment.body)}</p>`).join('')}`
        : '';

    return {
        title,
        html: `${postHtml}${commentsHtml}`,
        text: textParts.join('\n\n'),
        author,
        siteName: 'Reddit'
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

        if (host === 'blog.csdn.net' && pathname.includes('/article/details/')) {
            return purifyCsdnArticle(html);
        }

        if ((host === 'juejin.cn' || host.endsWith('.juejin.cn') || host === 'juejin.im') && pathname.includes('/post/')) {
            return purifyJuejinArticle(html);
        }

        if ((host === 'zhuanlan.zhihu.com' || host === 'www.zhihu.com' || host === 'zhihu.com')
            && (pathname.includes('/p/') || pathname.includes('/question/') || pathname.includes('/answer/'))) {
            return purifyZhihuContent(html);
        }

        if ((host === 'cnblogs.com' || host.endsWith('.cnblogs.com'))
            && (pathname.includes('/p/') || pathname.includes('/archive/'))) {
            return purifyCnblogsArticle(html);
        }

        if ((host === 'reddit.com' || host.endsWith('.reddit.com')) && pathname.includes('/comments/')) {
            return purifyRedditThread(html);
        }

        return undefined;
    } catch {
        return undefined;
    }
}
