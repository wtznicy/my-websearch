import axios from 'axios';
import {SearchResult} from '../../types.js';

interface LinuxDoTopic {
    id: number;
    title: string;
}

interface LinuxDoPost {
    topic_id: number;
    blurb: string;
}

interface LinuxDoResponse {
    topics: LinuxDoTopic[];
    posts: LinuxDoPost[];
}

export async function searchLinuxDo(query: string, limit: number): Promise<SearchResult[]> {

    let allResults: SearchResult[] = [];
    let pn = 1;

    try {
        while (allResults.length < limit) {
            const response = await axios.get<LinuxDoResponse>('https://linux.do/search', {
                params: {
                    q: query,
                    page: pn
                },
                headers: {
                    'accept': 'application/json, text/javascript, */*; q=0.01',
                    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'cache-control': 'no-cache',
                    'discourse-logged-in': 'true',
                    'discourse-present': 'true',
                    'pragma': 'no-cache',
                    'referer': `https://linux.do/search?q=${encodeURIComponent(query)}`,
                    'sec-ch-ua': '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
                    'sec-ch-ua-arch': '"x86"',
                    'sec-ch-ua-bitness': '"64"',
                    'sec-ch-ua-full-version': '"112.0.5615.50"',
                    'sec-ch-ua-full-version-list': '"Chromium";v="112.0.5615.50", "Google Chrome";v="112.0.5615.50", "Not:A-Brand";v="99.0.0.0"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-model': '""',
                    'sec-ch-ua-platform': '"Windows"',
                    'sec-ch-ua-platform-version': '"15.0.0"',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'same-origin',
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
                    'x-csrf-token': 'rF666BQ4uLOa-4Vi59MHJr17xjq0RsuISMrSiur0qudsZ_HU65gOf145uNIQ7yeRv291uU3GhCL-cm3ILlO78w',
                    'x-requested-with': 'XMLHttpRequest',
                    'Cookie': '_ga=GA1.1.1014556084.1750571986; cf_clearance=OHwsuY8kOismHG8rBN1tCKczIEyTdoJrMPH65aPVUSI-1750571989-1.2.1.1-uJ4vrRUBXQtFG8Ws7JrPw0VNT8_YWVWOz1GSvHyAWTCUPPC8PNqnKApl9hVhLHHs4kB.sQ4B0V54VEwG.RT23ewifTx0rifGNIVItA1Tt5Sq1M78h7sqlwaW7p0vWYuAasaSwcZLKElbcwIxDGd4_EU44Lss.jIl0p9PYPa9QWlUCtbwHISkR8lt8zHtX_YIFrU25pjsHLkLqzYgk7mpmEwAaryi4wgxoc7R0u_FqP5kD1Fq4t559mXPdvj3H23004H12XYT95hHNudrfmHUbO6yLzrspsmV0rdUxJHLwCtI_0aK6JvrQNGJpU13_XS0Q8R_WKOLYrVgHLC_wmg_YOJJ2tMRkJFt_yV2pHV0JPLCvN5I986ooXiLXkVAWvNQ; __stripe_mid=45e0bc73-88a1-4392-9a8e-56b3ad60d5017557f5; __stripe_sid=23ed10a8-f6f4-4cd8-948b-386cb239067ad435dc; _ga_1X49KS6K0M=GS2.1.s1750571986$o1$g1$t1750571999$j47$l0$h1911122445'
                }
            });

            const { topics, posts } = response.data;

            if (!Array.isArray(topics) || !Array.isArray(posts)) {
                break;
            }

            // topics 转 Map
            const topicMap = new Map<number, string>(topics.map(t => [t.id, t.title]));

            // 组合结果
            const results: SearchResult[] = posts.map(post => ({
                title: topicMap.get(post.topic_id) || '',
                url: `https://linux.do/t/${post.topic_id}.json?track_visit=true&forceLoad=true`,
                description: post.blurb,
                source: 'linux.do',
                engine: 'linux.do'
            }));

            allResults = allResults.concat(results);

            if (results.length === 0) {
                console.log('⚠️ No more results, ending early....');
                break;
            }

            pn += 1; // 下一页
        }

        return allResults.slice(0, limit);
    } catch (error: any) {
        console.error('❌ 搜索失败:', error.message || error);
        return [];
    }
}
