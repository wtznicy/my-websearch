import axios from 'axios';
import * as cheerio from 'cheerio';



export async function fetchZhiHuArticle(url: string): Promise<{ content: string }> {
    // Extract article ID from URL if needed
    const match = url.match(/\/p\/(\d+)/);
    const articleId = match ? match[1] : null;

    if (!articleId) {
        throw new Error('Invalid URL: Cannot extract article ID.');
    }


    // Make request with all the headers from the curl command
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'cache-control': 'max-age=0',
            'sec-ch-ua': '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'upgrade-insecure-requests': '1',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
            'referer': url,
            'accept-language': 'zh-CN,zh;q=0.9',
            'Cookie': '_xsrf=ntclIRA8DLBNwWxJxHwStrmJsOQoiO2V; __zse_ck=004_0UaB19lhaterkfMNfLxLYUoXLVe=hMr2o08LgWzBHEGeI5vXj6XIojTYQ6gWRrm2gcpC9RyAJnebKpy4Toy9=nX/W06EVZH/nTGdXKFvCqa8uQFtmdES653M2twjknVo-xdSh4wa6z3oaAvm1FSK/jY7z4m0hORwXBTrl8K/1P0ZubfcectwKQd9h0utH9Ih7N9r6LgJJYwC8VVBp+8NFSEExSsuP7xjNJ1zsJbyjeQFAZCFrQ/4Us3wuiIUDeq0d'
            // 'Cookie': '_xsrf=ntclIRA8DLBNwWxJxHwStrmJsOQoiO2V; __zse_ck=004_3oQ5Sj8V3iVCCDVdoH4Q014ZvG07VU6MbmAog/fEgBh7530ynIXdS=b7InC0p/QVS82KxyGP3ruIan5TTM510ZzN0R=0hyNrmXCriD=llJ6Bj3sTSUz3xyKtcM1GYU=E-aASd5ksG+6GtlPXZUCNfLo8vndJdGiEZXd7i7W1pFUACexR58aYV6eXEa+OnfoKIDADScLm//BjWH/O4hrDCQAOK/j1eDAzKzL6URXcRzZI5ytB1cu2kTWNUBxcU0dD4'
            // 'Cookie': cookies
        }
    });

    const $ = cheerio.load(response.data);

    let content = '';

    // Look for content inside specific ID
    const contentElement = $('#content');
    contentElement.find('script, style').remove();
    if (contentElement.length > 0) {
        content = contentElement.text().trim();
    }

    return { content: content };


}
