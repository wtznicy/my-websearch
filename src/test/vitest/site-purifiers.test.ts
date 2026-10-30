import { describe, it, expect } from 'vitest';
import {
    purifyWeChatArticle,
    purifyStackOverflowQuestion,
    purifyCsdnArticle,
    purifyJuejinArticle,
    purifyZhihuContent,
    purifyCnblogsArticle,
    purifyRedditThread,
    purifySiteContent
} from '../../engines/web/sitePurifiers.js';

describe('Site Purifiers (mp.weixin.qq.com & stackoverflow.com)', () => {
    describe('WeChat Articles (mp.weixin.qq.com)', () => {
        it('purifies wechat article and converts data-src on images to src', () => {
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>微信文章标题</title>
                </head>
                <body>
                    <h1 id="activity-name">AI 大模型实战开发技巧</h1>
                    <span id="js_name">深度学习实验室</span>
                    <div id="js_content">
                        <p>欢迎阅读本文。这是正文内容。</p>
                        <img data-src="https://mmbiz.qpic.cn/image123" alt="demo" />
                        <div class="qr_code_pc">请扫码关注</div>
                        <div class="reward_area">赞赏支持</div>
                    </div>
                </body>
                </html>
            `;

            const res = purifyWeChatArticle(html);
            expect(res).toBeDefined();
            expect(res?.title).toBe('AI 大模型实战开发技巧');
            expect(res?.author).toBe('深度学习实验室');
            expect(res?.siteName).toBe('微信公众号: 深度学习实验室');
            expect(res?.html).toContain('src="https://mmbiz.qpic.cn/image123"');
            expect(res?.html).not.toContain('data-src');
            expect(res?.html).not.toContain('请扫码关注');
            expect(res?.text).toContain('欢迎阅读本文。这是正文内容。');
        });

        it('returns undefined if #js_content is missing', () => {
            const html = '<html><body><h1>Not a wechat article</h1></body></html>';
            expect(purifyWeChatArticle(html)).toBeUndefined();
        });
    });

    describe('Stack Overflow Questions', () => {
        it('purifies question, accepted answer and top other answers', () => {
            const html = `
                <html>
                <head><title>How to handle async errors in Express?</title></head>
                <body>
                    <div id="question-header"><h1><a href="/questions/12345/express">How to handle async errors in Express?</a></h1></div>
                    <div id="question">
                        <div class="js-post-body"><p>I am trying to catch async errors in route handlers.</p></div>
                    </div>
                    <div class="answer accepted-answer">
                        <div class="js-vote-count">452</div>
                        <div class="js-post-body"><p>Use express-async-errors or write an asyncHandler wrapper.</p></div>
                    </div>
                    <div class="answer">
                        <div class="js-vote-count">120</div>
                        <div class="js-post-body"><p>In Express 5, promises are handled natively.</p></div>
                    </div>
                    <div class="sidebar">Ignore this ad and sidebar</div>
                </body>
                </html>
            `;

            const res = purifyStackOverflowQuestion(html);
            expect(res).toBeDefined();
            expect(res?.title).toBe('How to handle async errors in Express?');
            expect(res?.siteName).toBe('Stack Overflow');
            expect(res?.html).toContain('<h2>Question</h2>');
            expect(res?.html).toContain('I am trying to catch async errors in route handlers.');
            expect(res?.html).toContain('<h2>Accepted Answer (Score: 452)</h2>');
            expect(res?.html).toContain('Use express-async-errors or write an asyncHandler wrapper.');
            expect(res?.html).toContain('<h2>Other High-Voted Answer (Score: 120)</h2>');
            expect(res?.html).toContain('In Express 5, promises are handled natively.');
            expect(res?.html).not.toContain('Ignore this ad');
        });
    });

    describe('CSDN Articles (blog.csdn.net)', () => {
        it('purifies CSDN article, extracts title, author, and strips promo sections', () => {
            const html = `
                <!DOCTYPE html>
                <html>
                <head><title>Vue3 核心原理剖析_前端架构师_CSDN博客</title></head>
                <body>
                    <h1 class="title-article" id="articleContentId">Vue3 核心原理剖析</h1>
                    <a class="follow-nickName">前端大牛</a>
                    <div id="content_views" class="markdown_views prism-atom-one-dark">
                        <p>Vue3 采用了基于 Proxy 的响应式系统，相较于 Vue2 的 Object.defineProperty 有质的飞跃。本篇深入剖析其实现细节与源码机制。</p>
                        <div class="recommend-box">相关推荐内容</div>
                        <div class="toolbar">分享点赞</div>
                        <p>扫码关注大模型技术社区，免费公开项目源码包！</p>
                    </div>
                </body>
                </html>
            `;

            const res = purifyCsdnArticle(html);
            expect(res).toBeDefined();
            expect(res?.title).toBe('Vue3 核心原理剖析');
            expect(res?.author).toBe('前端大牛');
            expect(res?.siteName).toBe('CSDN博客: 前端大牛');
            expect(res?.text).toContain('Vue3 采用了基于 Proxy 的响应式系统');
            expect(res?.text).not.toContain('扫码关注大模型技术社区');
            expect(res?.html).not.toContain('recommend-box');
        });

        it('returns undefined for soft 404 pages', () => {
            const html = '<html><body><h1>你想找的内容离你而去了</h1></body></html>';
            expect(purifyCsdnArticle(html)).toBeUndefined();
        });
    });

    describe('Juejin Articles (juejin.cn)', () => {
        it('purifies Juejin article, extracts title, author, and strips noise', () => {
            const html = `
                <!DOCTYPE html>
                <html>
                <head><title>深入理解 React 19 新特性 - 掘金</title></head>
                <body>
                    <h1 class="article-title">深入理解 React 19 新特性</h1>
                    <div class="author-name"><span class="name">技术极客</span></div>
                    <div class="markdown-body">
                        <p>React 19 带来了 Actions、use() 等重磅特性，极大简化了异步状态管理与全栈开发。下面我们通过实战代码逐一解析其用法。</p>
                        <div class="code-block-extension">复制代码</div>
                        <div class="hljs-ln-numbers">1 2 3</div>
                    </div>
                </body>
                </html>
            `;

            const res = purifyJuejinArticle(html);
            expect(res).toBeDefined();
            expect(res?.title).toBe('深入理解 React 19 新特性');
            expect(res?.author).toBe('技术极客');
            expect(res?.siteName).toBe('稀土掘金: 技术极客');
            expect(res?.text).toContain('React 19 带来了 Actions');
            expect(res?.html).not.toContain('code-block-extension');
            expect(res?.html).not.toContain('hljs-ln-numbers');
        });
    });

    describe('Zhihu articles and answers', () => {
        it('extracts RichText content and removes login/recommendation noise', () => {
            const html = `
                <html><body>
                    <h1 class="QuestionHeader-title">如何理解 Rust 所有权？</h1>
                    <div class="AuthorInfo-name">张三</div>
                    <div class="RichText ztext">
                        <p>所有权是 Rust 内存安全的核心机制。</p>
                        <div class="ContentItem-actions">赞同 123</div>
                        <div class="Recommendations">相关推荐</div>
                    </div>
                    <div class="LoginModal">登录后继续</div>
                </body></html>
            `;
            const res = purifyZhihuContent(html);
            expect(res).toBeDefined();
            expect(res?.title).toBe('如何理解 Rust 所有权？');
            expect(res?.author).toBe('张三');
            expect(res?.text).toContain('所有权是 Rust 内存安全的核心机制');
            expect(res?.html).not.toContain('相关推荐');
        });
    });

    describe('Cnblogs articles', () => {
        it('extracts post body and removes footer noise', () => {
            const html = `
                <html><body>
                    <h1 id="cb_post_title_url">深入理解 .NET 依赖注入</h1>
                    <div id="post_author">李四</div>
                    <div id="cnblogs_post_body">
                        <p>依赖注入是一种控制反转的实现方式。</p>
                        <div class="postDesc">版权声明</div>
                    </div>
                </body></html>
            `;
            const res = purifyCnblogsArticle(html);
            expect(res).toBeDefined();
            expect(res?.title).toBe('深入理解 .NET 依赖注入');
            expect(res?.author).toBe('李四');
            expect(res?.text).toContain('依赖注入是一种控制反转');
            expect(res?.html).not.toContain('版权声明');
        });
    });

    describe('Reddit threads', () => {
        it('formats the post and top comments by score', () => {
            const html = `
                <html><body>
                    <shreddit-post post-title="What is the best Rust async runtime?" author="alice" score="42">
                        <div slot="text-body">I am comparing Tokio and async-std.</div>
                    </shreddit-post>
                    <shreddit-comment author="bob" score="12" depth="0"><div slot="comment">Tokio is the most widely used.</div></shreddit-comment>
                    <shreddit-comment author="carol" score="30" depth="1"><div slot="comment">Consider smol for small binaries.</div></shreddit-comment>
                </body></html>
            `;
            const res = purifyRedditThread(html);
            expect(res).toBeDefined();
            expect(res?.title).toBe('What is the best Rust async runtime?');
            expect(res?.text).toContain('## Top comments');
            expect(res?.text).toContain('[30] u/carol');
            const text = res?.text ?? '';
            expect(text.indexOf('[30] u/carol')).toBeLessThan(text.indexOf('[12] u/bob'));
        });
    });

    describe('purifySiteContent dispatcher', () => {
        it('routes mp.weixin.qq.com correctly', () => {
            const html = '<div id="js_content"><p>Wechat content</p></div>';
            const res = purifySiteContent('https://mp.weixin.qq.com/s/xyz123', html);
            expect(res).toBeDefined();
            expect(res?.text).toBe('Wechat content');
        });

        it('routes stackoverflow.com/questions/... correctly', () => {
            const html = '<div id="question"><div class="js-post-body"><p>SO content</p></div></div>';
            const res = purifySiteContent('https://stackoverflow.com/questions/999/test-question', html);
            expect(res).toBeDefined();
            expect(res?.html).toContain('SO content');
        });

        it('routes blog.csdn.net/.../article/details/... correctly', () => {
            const html = '<h1 id="articleContentId">CSDN Title</h1><div id="content_views"><p>CSDN 文章详细正文内容必须足够长超过一百字以便提纯器能够识别出有效内容，否则会被当作片段忽略。</p></div>';
            const res = purifySiteContent('https://blog.csdn.net/user/article/details/123456', html);
            expect(res).toBeDefined();
            expect(res?.title).toBe('CSDN Title');
        });

        it('routes juejin.cn/post/... correctly', () => {
            const html = '<h1 class="article-title">Juejin Title</h1><div class="markdown-body"><p>Juejin 文章详细正文内容必须足够长超过一百字以便提纯器能够识别出有效内容，否则会被当作片段忽略。</p></div>';
            const res = purifySiteContent('https://juejin.cn/post/7234567890123456789', html);
            expect(res).toBeDefined();
            expect(res?.title).toBe('Juejin Title');
        });

        it('routes zhihu question and cnblogs article pages', () => {
            const zhihu = purifySiteContent(
                'https://www.zhihu.com/question/123/answer/456',
                '<h1 class="QuestionHeader-title">Zhihu Q</h1><div class="RichText ztext"><p>知乎正文内容</p></div>'
            );
            expect(zhihu?.text).toContain('知乎正文内容');

            const cnblogs = purifySiteContent(
                'https://www.cnblogs.com/user/p/123.html',
                '<h1 id="cb_post_title_url">Cnblogs T</h1><div id="cnblogs_post_body"><p>博客园正文</p></div>'
            );
            expect(cnblogs?.text).toContain('博客园正文');
        });

        it('returns undefined for other hosts', () => {
            expect(purifySiteContent('https://example.com/page', '<div>content</div>')).toBeUndefined();
        });
    });
});
