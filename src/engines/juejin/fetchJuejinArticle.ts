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
                'Upgrade-Insecure-Requests': '1'
            }
        });

        const $ = cheerio.load(response.data);

        // 掘金文章内容的可能选择器
        const selector = '.markdown-body';

        let content = '';


        console.log(`🔍 Trying selector: ${selector}`);
        const element = $(selector);
        if (element.length > 0) {
            console.log(`✅ Found content with selector: ${selector}`);
            // 移除脚本和样式标签
            element.find('script, style, .code-block-extension').remove();
            content = element.text().trim();
        }

        console.log(`✅ Successfully extracted ${content.length} characters`);
        return { content };

    } catch (error) {
        console.error('❌ 获取掘金文章失败:', error);
        throw new Error(`获取掘金文章失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
}
