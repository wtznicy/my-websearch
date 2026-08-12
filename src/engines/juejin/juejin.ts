import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { BROWSER_USER_AGENT } from '../../utils/constants.js';

interface JuejinSearchResponse {
    err_no: number;
    err_msg: string;
    data: Array<{
        result_type: number;
        result_model: {
            article_id: string;
            article_info: {
                title: string;
                brief_content: string;
                view_count: number;
                digg_count: number;
                comment_count: number;
                ctime: string;
            };
            author_user_info: {
                user_name: string;
                avatar_large: string;
                description: string;
            };
            category: {
                category_name: string;
            };
            tags: Array<{
                tag_name: string;
            }>;
        };
        title_highlight: string;
        content_highlight: string;
    }>;
    cursor: string;
    has_more: boolean;
}

/** 把 highlight HTML 转成纯文本：剥掉 <em> 高亮标签并解码 HTML 实体（&#34; → " 等） */
function highlightToText(html: string): string {
    if (!html) {
        return '';
    }
    return cheerio.load(html).root().text().trim();
}

export async function searchJuejin(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let cursor = '0';

    try {
        while (allResults.length < limit) {
            console.error(`🔍 Searching Juejin with query: "${query}", cursor: ${cursor}`);

            const response = await axios.get<JuejinSearchResponse>('https://api.juejin.cn/search_api/v1/search', buildAxiosRequestOptions({ engine: 'juejin',
                trustedStaticHost: true,
                params: {
                    aid: '2608',
                    // 不再硬编码设备 uuid（所有安装共享同一 ID，易被识别）；让服务端生成
                    spider: '0',
                    query: query,
                    id_type: '0',
                    cursor: cursor,
                    limit: Math.min(20, limit - allResults.length),
                    search_type: '0',
                    sort_type: '0',
                    version: '1'
                },
                headers: {
                    'pragma': 'no-cache',
                    'priority': 'u=1, i',
                    'User-Agent': BROWSER_USER_AGENT,
                    'content-type': 'application/json',
                    'Accept': '*/*',
                    'Connection': 'keep-alive'
                }
            }));

            const responseData = response.data;

            if (responseData.err_no !== 0) {
                console.error(`❌ Juejin API error: ${responseData.err_msg}`);
                break;
            }

            if (!responseData.data || !Array.isArray(responseData.data)) {
                console.error('⚠️ No more results from Juejin API');
                break;
            }

            const results: SearchResult[] = responseData.data.map((item) => {
                const { result_model, title_highlight, content_highlight } = item;
                const { article_info, author_user_info, category, tags } = result_model;

                // 高亮片段转纯文本：去 <em> 标签并解码 HTML 实体
                const cleanTitle = highlightToText(title_highlight);
                const cleanContent = highlightToText(content_highlight);

                // 构建描述信息
                const tagNames = tags.map(tag => tag.tag_name).join(', ');
                const description = `${cleanContent} | 分类: ${category.category_name} | 标签: ${tagNames} | 👍 ${article_info.digg_count} | 👀 ${article_info.view_count}`;

                return {
                    title: cleanTitle,
                    url: `https://juejin.cn/post/${result_model.article_id}`,
                    description: description,
                    source: author_user_info.user_name,
                    engine: 'juejin'
                };
            });

            allResults = allResults.concat(results);

            // 检查是否有下一页
            if (!responseData.has_more || !responseData.cursor || results.length === 0) {
                console.log('⚠️ No more results, ending search');
                break;
            }

            cursor = responseData.cursor;
        }

        console.log(`✅ Juejin search completed, found ${allResults.length} results`);
        return allResults.slice(0, limit);

    } catch (error) {
        console.error('❌ Juejin search failed:', error instanceof Error ? error.message : String(error));
        if (axios.isAxiosError(error)) {
            console.error('Response status:', error.response?.status);
            console.error('Response data:', error.response?.data);
        }
        // 向上抛错，由 searchService 的重试 + partialFailures 机制接管
        throw error;
    }
}
