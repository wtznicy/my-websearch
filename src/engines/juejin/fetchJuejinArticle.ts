import * as cheerio from 'cheerio';
import { buildAxiosRequestOptions, requestDirectFirst, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { htmlToMarkdown } from '../../utils/markdown.js';
import { AppError, extractErrorCode, extractErrorStatus, isAppError, isRetryableError, normalizePublicErrorCode } from '../../core/errors.js';

function shouldDebug(): boolean {
    return (process.env.LOG_LEVEL ?? '').toLowerCase() === 'debug';
}

/**
 * 输出格式：默认纯文本（行为兼容）。`markdown` 会把正文容器转成 Markdown，
 * 保留代码围栏（含语言）与表格——掘金正文原本只走 `.text()`，代码缩进/表格结构/语言标识全丢
 * （测评报告 P1-10），且没有 markdown 输出路径。
 */
export type JuejinArticleOptions = { format?: 'text' | 'markdown' };

export function extractJuejinTitle(html: string): string {
    if (!html) return '';
    const $ = cheerio.load(html);
    return $('.article-title').text().trim() ||
        $('h1.article-title').text().trim() ||
        $('h1').first().text().trim() ||
        $('title').text().replace(/ - 掘金$/, '').trim();
}

import { MOBILE_IOS_UA } from '../../utils/userAgents.js';

export async function fetchJuejinArticle(url: string, options: JuejinArticleOptions = {}): Promise<{ content: string; title?: string }> {
    try {
        if (shouldDebug()) {
            console.error(`🔍 Fetching Juejin article: ${url}`);
        }

        // 直连优先、代理兜底：先无代理，网络失败且配置了代理时自动切换
        const response = await requestDirectFirst('GET', url, (forceDirect) => buildAxiosRequestOptions({
            headers: {
                'User-Agent': MOBILE_IOS_UA,
                'Connection': 'keep-alive',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'pragma': 'no-cache',
                'cache-control': 'no-cache',
                'upgrade-insecure-requests': '1',
                'sec-fetch-site': 'none',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-user': '?1',
                'sec-fetch-dest': 'document',
                'accept-language': 'zh-CN,zh;q=0.9',
                'priority': 'u=0, i'
            },
            // 直连+代理兜底最坏 2×10s，保持在 MCP 客户端 30s 超时预算内（掘金正常响应远快于 10s）
            timeout: 10000,
            decompress: true,
            forceDirect
        }), 'Juejin article URL');

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
        let contentHtml = '';

        // 尝试多个选择器
        for (const selector of selectors) {
            if (shouldDebug()) {
                console.error(`🔍 Trying selector: ${selector}`);
            }
            const element = $(selector);
            if (element.length > 0) {
                if (shouldDebug()) {
                    console.error(`✅ Found content with selector: ${selector}`);
                }
                // 移除脚本和样式标签
                element.find('script, style, .code-block-extension, .hljs-ln-numbers').remove();
                content = element.text().trim();
                contentHtml = element.html() || '';

                if (content.length > 100) { // 确保内容足够长
                    break;
                }
            }
        }

        // 如果所有选择器都失败，尝试提取页面主要文本内容
        if (!content || content.length < 100) {
            if (shouldDebug()) {
                console.error('⚠️ All selectors failed, trying fallback extraction');
            }
            $('script, style, nav, header, footer, .sidebar, .comment').remove();
            content = $('body').text().trim();
            contentHtml = $('body').html() || '';
        }

        // format=markdown：保留代码围栏（含语言）与表格结构；转换失败时保留纯文本
        if (options.format === 'markdown' && contentHtml) {
            try {
                const markdown = htmlToMarkdown(contentHtml);
                if (markdown) {
                    content = markdown;
                }
            } catch (error) {
                console.error('⚠️ Juejin markdown conversion failed, keeping plain text:', error instanceof Error ? error.message : String(error));
            }
        }

        // 内容仍为空时抛错，而不是静默返回成功——空成功响应会让 LLM 误以为抓到了文章
        if (!content) {
            throw new AppError({
                code: 'empty_content',
                retryable: false,
                engine: 'juejin',
                message: 'No readable Juejin article content was extracted'
            });
        }

        const title = extractJuejinTitle(response.data);

        // P1-1: 判定反爬/人机挑战与 soft 404
        const isChallenge =
            /please\s+wait/i.test(content) ||
            /just\s+a\s+moment/i.test(content) ||
            (content.length < 50 && (!title || title.trim().length === 0));

        if (isChallenge) {
            throw new AppError({
                code: 'bot_challenge',
                retryable: false,
                status: 403,
                engine: 'juejin',
                message: '掘金文章触发反爬验证 (Please wait...)，未能获取有效正文内容'
            });
        }

        const isSoft404 =
            /(?:^|[\s_-])404(?:[\s_-]|$)|页面找不到了|文章不存在|该内容已被删除|你似乎来到了没有知识存在的荒原/i.test(title || '') ||
            (content.length < 300 && /(?:^|[\s_-])404\s+not\s+found|页面找不到了|文章不存在或已被删除|内容已被删除|没有知识存在的荒原/i.test(content));

        if (isSoft404) {
            throw new AppError({
                code: 'not_found',
                retryable: false,
                status: 404,
                engine: 'juejin',
                message: `掘金文章不存在或已被删除 (404): ${url}`
            });
        }

        if (shouldDebug()) {
            console.error(`✅ Successfully extracted ${content.length} characters`);
        }
        return { content, title: title || undefined };

    } catch (error) {
        if (isAppError(error)) {
            throw error;
        }
        console.error('❌ 获取掘金文章失败:', error instanceof Error ? error.message : String(error));
        throw new AppError({
            code: normalizePublicErrorCode(extractErrorCode(error)) ?? 'network_error',
            retryable: isRetryableError(error),
            status: extractErrorStatus(error),
            engine: 'juejin',
            cause: error,
            message: `获取掘金文章失败: ${error instanceof Error ? error.message : '未知错误'}`
        });
    }
}
