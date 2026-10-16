import { describe, it, expect } from 'vitest';
import { purifyWeChatArticle, purifyStackOverflowQuestion, purifySiteContent } from '../../engines/web/sitePurifiers.js';

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

        it('returns undefined for other hosts', () => {
            expect(purifySiteContent('https://example.com/page', '<div>content</div>')).toBeUndefined();
        });
    });
});
