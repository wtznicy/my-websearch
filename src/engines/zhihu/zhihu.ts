import axios from 'axios';
import {SearchResult} from '../../types.js';
import { config } from '../../config.js';
import {searchDuckDuckGo} from "../duckduckgo/index.js";
import * as cheerio from 'cheerio';

async function searchBingForZhiHu(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 0;
    // Format query for URL
    const encodedQuery = encodeURIComponent(query);

    try {
        while (allResults.length < limit) {
            const response = await axios.get('https://cn.bing.com/search', {
                params: {
                    "q": query,
                    "qs": "n",
                    "form": "QBRE",
                    "sp": "-1",
                    "lq": "0",
                    "pq": query,
                    "sc": "5-36",
                    "sk": "",
                    "cvid": "EC2944BAA67C4476B26D801B068E79FD",
                    "rdr": "1",
                    "rdrig": "03977EC990574FBF94EC11E34B85CD62",
                    "first": 2 + pn * 10,
                },
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
                    "Connection": "keep-alive",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                    "Accept-Encoding": "gzip, deflate, br",
                    "cache-control": "max-age=0",
                    "ect": "4g",
                    "sec-ch-ua": "\"Chromium\";v=\"112\", \"Google Chrome\";v=\"112\", \"Not:A-Brand\";v=\"99\"",
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-full-version": "\"112.0.5615.50\"",
                    "sec-ch-ua-arch": "\"x86\"",
                    "sec-ch-ua-platform": "\"Windows\"",
                    "sec-ch-ua-platform-version": "\"15.0.0\"",
                    "sec-ch-ua-model": "\"\"",
                    "sec-ch-ua-bitness": "\"64\"",
                    "sec-ch-ua-full-version-list": "\"Chromium\";v=\"112.0.5615.50\", \"Google Chrome\";v=\"112.0.5615.50\", \"Not:A-Brand\";v=\"99.0.0.0\"",
                    "upgrade-insecure-requests": "1",
                    "sec-fetch-site": "none",
                    "sec-fetch-mode": "navigate",
                    "sec-fetch-user": "?1",
                    "sec-fetch-dest": "document",
                    "accept-language": "zh-CN,zh;q=0.9"
                }
            });

            const $ = cheerio.load(response.data);
            const results: SearchResult[] = [];

            $('#b_content').children()
                .find('#b_results').children()
                .each((i, element) => {
                    const titleElement = $(element).find('h2');
                    const linkElement = $(element).find('a');
                    const snippetElement = $(element).find('p').first();

                    if (titleElement.length && linkElement.length) {
                        const url = linkElement.attr('href');
                        if (url && url.startsWith('http') && url.includes('zhuanlan.zhihu.com')) {
                            const sourceElement = $(element).find('.b_tpcn');
                            results.push({
                                title: titleElement.text(),
                                url: url,
                                description: snippetElement.text().trim() || '',
                                source: 'zhuanlan.zhihu.com',
                                engine: 'bing'
                            });
                        }
                    }
                });

            allResults = allResults.concat(results);

            if (results.length === 0) {
                console.error('⚠️ No more results from Bing, ending early....');
                break;
            }

            pn += 1;
        }

        return allResults.slice(0, limit);
    } catch (error: any) {
        console.error('❌ Bing search failed:', error.message || error);
        return [];
    }
}


export async function searchZhiHu(query: string, limit: number): Promise<SearchResult[]> {

    console.error(`🔍 Searching zhuanlan.zhihu.com with "${query}" using ${config.defaultSearchEngine} engine`);

    // Create the site-specific query
    const siteQuery = `site:zhuanlan.zhihu.com ${query}`;

    let results: SearchResult[] = [];

    try {
        // Use the configured search engine
        if (config.defaultSearchEngine === 'duckduckgo') {
            results = await searchDuckDuckGo(siteQuery, limit);
        } else {
            // Default to Bing
            results = await searchBingForZhiHu(siteQuery, limit);
        }

        // Filter results to ensure they're from zhuanlan.zhihu.com
        const filteredResults = results.filter(result => {
            try {
                const url = new URL(result.url);
                return url.hostname === 'zhuanlan.zhihu.com';
            } catch {
                return false;
            }
        });

        // Update source to be consistent
        filteredResults.forEach(result => {
            result.source = 'zhuanlan.zhihu.com';
            // Keep the original engine info
        });

        return filteredResults.slice(0, limit);
    } catch (error: any) {
        console.error(`❌ zhuanlan.zhihu.com search failed using ${config.defaultSearchEngine}:`, error.message || error);
        return [];
    }

}
