import { describe, it, expect } from 'vitest';
import { parseCsdnResults, stripHighlightTags } from '../../engines/csdn/csdn.js';

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
