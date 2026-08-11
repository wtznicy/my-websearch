import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

export async function searchCsdn(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 1;

    while (allResults.length < limit) {
        const response = await axios.get('https://so.csdn.net/api/v3/search', buildAxiosRequestOptions({ engine: 'csdn',
            trustedStaticHost: true,
            params: {
                q: query,
                p: pn
            },
            headers: {
                'Pragma': 'no-cache',
                // 不再硬编码会话 Cookie（含 waf_captcha_marker 等抓包痕迹，会过期且属轻微凭据泄漏），
                // 让服务端为新会话发 Cookie；UA 用与其它引擎一致的现代浏览器
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            }
        }));

        const { result_vos } = response.data

        if (!Array.isArray(result_vos)) {
            break
        }

        const results: SearchResult[] = [];


        result_vos.forEach(re => {

            const { digest, title, url_location,nickname } = re

            results.push ({
                title: title,
                url: url_location,
                description: digest,
                source: nickname,
                engine: "csdn"
            });
        });

        allResults = allResults.concat(results);

        if (results.length === 0) {
            console.error('⚠️ No more results, ending early....');
            break;
        }

        pn += 1;
    }

    return allResults.slice(0, limit); // 截取最多 limit 个
}
