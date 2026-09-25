import { describe, it, expect, afterEach } from 'vitest';
import type { AxiosResponse } from 'axios';
import { parseCsdnResults, stripHighlightTags, searchCsdn, __setCsdnHttpGetForTests } from '../../engines/csdn/csdn.js';

const RESULT_VOS = [
    {
        digest: '这是<em>高亮</em>摘要',
        title: '标题<em>一</em>',
        url_location: 'https://blog.csdn.net/user1/article/details/111',
        nickname: '作者甲'
    },
    {
        digest: '第二条摘要',
        title: '标题二',
        url_location: 'https://blog.csdn.net/user2/article/details/222',
        nickname: ''
    },
    {
        digest: '无 URL 条目',
        title: '无 URL 条目',
        url_location: '',
        nickname: '作者乙'
    }
];

describe('parseCsdnResults', () => {
    it('should map result_vos and strip em highlight tags', () => {
        const results = parseCsdnResults(RESULT_VOS as never, new Set<string>());

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            title: '标题一',
            url: 'https://blog.csdn.net/user1/article/details/111',
            description: '这是高亮摘要',
            source: '作者甲',
            engine: 'csdn'
        });
        // nickname 为空时 source 保持空字符串
        expect(results[1].source).toBe('');
    });

    it('should skip entries without a url', () => {
        const results = parseCsdnResults(RESULT_VOS as never, new Set<string>());
        expect(results.some((r) => r.url === '')).toBe(false);
    });

    it('should filter download.csdn.net resource pages and entries without digest', () => {
        const vos = [
            ...RESULT_VOS,
            {
                digest: '下载页摘要',
                title: '下载资源',
                url_location: 'https://download.csdn.net/download/user/123',
                nickname: '作者'
            },
            {
                digest: '',
                title: '无摘要条目',
                url_location: 'https://blog.csdn.net/user3/article/details/333',
                nickname: '作者丙'
            }
        ];
        const results = parseCsdnResults(vos as never, new Set<string>());
        expect(results.some((r) => r.url.includes('download.csdn.net'))).toBe(false);
        expect(results.some((r) => r.title === '无摘要条目')).toBe(false);
        expect(results).toHaveLength(2); // 原 fixture 2 条有效 + 2 条被过滤
    });

    it('should dedupe urls via the provided seenUrls set', () => {
        const seenUrls = new Set<string>(['https://blog.csdn.net/user1/article/details/111']);
        const results = parseCsdnResults(RESULT_VOS as never, seenUrls);
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('标题二');
    });
});

describe('stripHighlightTags', () => {
    it('should remove em tags', () => {
        expect(stripHighlightTags('<em>高亮</em>文字')).toBe('高亮文字');
    });

    it('should return empty string for empty input', () => {
        expect(stripHighlightTags('')).toBe('');
        expect(stripHighlightTags(undefined as never)).toBe('');
    });
});

/** 构造 axios 形状的响应（data 可直接给对象，也可给字符串模拟 wreq 路径的原始文本） */
function mockResponse(data: unknown): AxiosResponse {
    return { data, status: 200, headers: {}, config: {}, request: {} } as unknown as AxiosResponse;
}

/** 真 0 结果的空响应（实测本机直连：613 字节、total=0、result_vos=[]） */
const EMPTY_PAYLOAD = {
    show_live_status: false,
    split_words: ['xyz', 'nonexistentquery'],
    total: 0,
    ad_list: [],
    sensitive_code: false,
    result_vos: [],
    isc: true,
    total_page: 0
};

function vos(count: number) {
    return Array.from({ length: count }, (_, i) => ({
        digest: `摘要${i}`,
        title: `标题${i}`,
        url_location: `https://blog.csdn.net/user${i}/article/details/${i}`,
        nickname: `作者${i}`
    }));
}

describe('searchCsdn 空响应判定', () => {
    afterEach(() => {
        __setCsdnHttpGetForTests();
    });

    it('冷门词的真 0 结果（total=0）应返回空数组，不得抛错', async () => {
        let calls = 0;
        __setCsdnHttpGetForTests(async () => {
            calls += 1;
            return mockResponse(EMPTY_PAYLOAD);
        });

        const results = await searchCsdn('xyz987654321nonexistentquery123', 10);

        expect(results).toHaveLength(0);
        // 首屏空 → 带 cookie 重试一次；两次都是合法空响应 → 判定为该词确实无结果
        expect(calls).toBe(2);
    });

    it('wreq 路径的 JSON 文本响应应被正常解析', async () => {
        __setCsdnHttpGetForTests(async () => mockResponse(JSON.stringify({ total: 30, result_vos: vos(2) })));

        const results = await searchCsdn('python 协程', 10);

        expect(results).toHaveLength(2);
        expect(results[0].title).toBe('标题0');
    });

    it('首屏无 cookie 空响应、重试拿到结果时应返回结果', async () => {
        let calls = 0;
        __setCsdnHttpGetForTests(async () => {
            calls += 1;
            return mockResponse(calls === 1 ? EMPTY_PAYLOAD : { total: 30, result_vos: vos(5) });
        });

        const results = await searchCsdn('websearch mcp', 3);

        expect(results).toHaveLength(3);
        expect(calls).toBe(2);
    });

    it('重试后仍为空且 total>0（自相矛盾）应显式报错', async () => {
        __setCsdnHttpGetForTests(async () => mockResponse({ total: 586, result_vos: [] }));

        await expect(searchCsdn('websearch mcp', 10)).rejects.toThrow(/empty response with total > 0/i);
    });

    it('非 JSON 响应（反爬 HTML）应显式报错', async () => {
        __setCsdnHttpGetForTests(async () => mockResponse('<html><body>blocked</body></html>'));

        await expect(searchCsdn('websearch mcp', 10)).rejects.toThrow(/non-JSON response/i);
    });

    it('缺少 result_vos 字段应显式报错', async () => {
        __setCsdnHttpGetForTests(async () => mockResponse({ total: 0, unexpected: true }));

        await expect(searchCsdn('websearch mcp', 10)).rejects.toThrow(/missing result_vos/i);
    });
});
