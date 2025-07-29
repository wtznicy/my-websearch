import axios from 'axios';
import * as cheerio from 'cheerio';

export async function fetchJuejinArticle(url: string): Promise<{ content: string }> {
    try {
        console.log(`🔍 Fetching Juejin article: ${url}`);

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'pragma': 'no-cache',
                'priority': 'u=0, i',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1',
                'Host': 'juejin.cn',
            }
        });

        const $ = cheerio.load(response.data);

        // 掘金文章内容的可能选择器（按优先级排序）
        const selectors = [
            '.markdown-body',
            '.article-content',
            '.content',
            '[data-v-md-editor-preview]',
            '.bytemd-preview',
            '.article-area .content',
            '.main-area .article-area',
            '.article-wrapper .content'
        ];

        let content = '';

        // 尝试多个选择器
        for (const selector of selectors) {
            console.log(`🔍 Trying selector: ${selector}`);
            const element = $(selector);
            if (element.length > 0) {
                console.log(`✅ Found content with selector: ${selector}`);
                // 移除脚本和样式标签
                element.find('script, style, .code-block-extension, .hljs-ln-numbers').remove();
                content = element.text().trim();

                if (content.length > 100) { // 确保内容足够长
                    break;
                }
            }
        }

        // 如果所有选择器都失败，尝试提取页面主要文本内容
        if (!content || content.length < 100) {
            console.log('⚠️ All selectors failed, trying fallback extraction');
            $('script, style, nav, header, footer, .sidebar, .comment').remove();
            content = $('body').text().trim();
        }

        console.log(`✅ Successfully extracted ${content.length} characters`);
        return { content };

    } catch (error) {
        console.error('❌ 获取掘金文章失败:', error);
        throw new Error(`获取掘金文章失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
}
