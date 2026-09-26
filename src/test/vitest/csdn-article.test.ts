import { describe, it, expect } from 'vitest';
import { __csdnArticleInternals } from '../../engines/csdn/fetchCsdnArticle.js';

const { extractArticleContent, isPromotionParagraph } = __csdnArticleInternals;

describe('CSDN 正文抽取容器兜底', () => {
    it('缺少 #content_views 时应退到其它容器（此前会截成几百字节）', () => {
        const body = '这是一篇完整的 CSDN 技术长文正文。'.repeat(40);
        const html = `<html><body>
            <div class="blog-content-box"><div class="article_content">${body}</div></div>
        </body></html>`;

        const content = extractArticleContent(html);

        expect(content.length).toBeGreaterThan(300);
        expect(content).toContain('这是一篇完整的 CSDN 技术长文正文');
    });

    it('所有容器都过短时应退到 body 纯文本并剔除噪声区块', () => {
        const html = `<html><body>
            <nav>首页 导航 登录</nav>
            <div>${'短正文'.repeat(3)}</div>
            <p>${'真正的正文内容段落。'.repeat(30)}</p>
            <footer>版权所有</footer>
        </body></html>`;

        const content = extractArticleContent(html);

        expect(content).toContain('真正的正文内容段落');
        expect(content).not.toContain('首页 导航 登录');
        expect(content).not.toContain('版权所有');
    });

    it('优先选最长候选，且命中 #content_views 时不做多余的宽容器回退', () => {
        const long = 'content_views 正文。'.repeat(60);
        const html = `<html><body><div id="content_views">${long}</div><div class="blog-content-box">少量噪声</div></body></html>`;

        expect(extractArticleContent(html)).toContain('content_views 正文');
    });
});

describe('CSDN 推广段判定（避免误删正文）', () => {
    it('长段落里出现单个泛化词不应被整段删除', () => {
        expect(isPromotionParagraph(`${'技术正文。'.repeat(40)}本教程免费公开给大家学习参考`)).toBe(false);
    });

    it('短段落命中特征词应判为推广', () => {
        expect(isPromotionParagraph('扫码进入大模型技术社区')).toBe(true);
        expect(isPromotionParagraph('本课程免费公开')).toBe(true);
    });

    it('长段落命中多个特征词仍判为推广（短句罗列的推广段）', () => {
        const promo = `${'推广语。'.repeat(35)}扫码加入大模型技术社区，附项目源码包与完整视频讲解`;
        expect(promo.length).toBeGreaterThan(120);
        expect(isPromotionParagraph(promo)).toBe(true);
    });
});
