import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from "../../utils/httpRequest.js";
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { paginateSearch } from '../../utils/pagination.js';

export async function searchBrave(query: string, limit: number): Promise<SearchResult[]> {
    const seenUrls = new Set<string>();
    const encodedQuery = encodeURIComponent(query);
    const requestOptions = buildAxiosRequestOptions({ engine: 'brave',
        trustedStaticHost: true,
        headers: {
            "User-Agent": BROWSER_USER_AGENT,
            "Connection": "keep-alive",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": "\"Chromium\";v=\"133\", \"Google Chrome\";v=\"133\", \"Not:A-Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "upgrade-insecure-requests": "1",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "navigate",
            "sec-fetch-user": "?1",
            "sec-fetch-dest": "document",
            "referer": "https://search.brave.com/",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
    });

    return paginateSearch({
        limit,
        fetchPage: async (pageIndex) => {
            const response = await axios.get(`https://search.brave.com/search?q=${encodedQuery}&source=web&offset=${pageIndex}`, requestOptions)

            const $ = cheerio.load(response.data);
            const results: SearchResult[] = [];

            // Brave now uses SvelteKit SSR. The page structure is:
            // #results > .snippet.svelte-* (top-level result card)
            //   └── .result-content
            //        ├── > a (main link with href)
            //        │   ├── .site-name-wrapper (source)
            //        │   └── .search-snippet-title (title)
            //        └── .generic-snippet (description)
            $('#results .snippet').each((index, element) => {
                const resultElement = $(element);
                const content = resultElement.find('.result-content').first();
                if (content.length === 0) return;

                // The first <a> inside .result-content is the main link
                const mainLink = content.find('> a').first();
                const url = mainLink.attr('href');

                // Title is inside .search-snippet-title
                const title = mainLink.find('.search-snippet-title').text().trim();

                // Description is in .generic-snippet
                const description = content.find('.generic-snippet').text().trim() || '';

                // Source/site name is in .site-name-wrapper
                const source = mainLink.find('.site-name-wrapper').first().text().trim() || '';

                // Ensure that we have a valid title and URL before adding
                if (title && url && !seenUrls.has(url)) {
                    seenUrls.add(url);
                    results.push({
                        title: title,
                        url: url,
                        description: description,
                        source: source,
                        engine: 'brave'
                    });
                }
            });

            return results;
        }
    });
}
