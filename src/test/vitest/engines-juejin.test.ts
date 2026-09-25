import { describe, it, expect } from 'vitest';
import { parseJuejinResults, highlightToText } from '../../engines/juejin/juejin.js';

const DATA = [
    {
        result_type: 0,
        result_model: {
            article_id: '7412345678901234567',
            article_info: {
                title: 'x',
                brief_content: 'y',
                view_count: 120,
                digg_count: 34,
                comment_count: 5,
                ctime: '0'
            },
            author_user_info: {
                user_name: '作者甲',
                avatar_large: '',
                description: ''
            },
            category: {
                category_name: '前端'
            },
            tags: [
                { tag_name: 'React' },
                { tag_name: 'MCP' }
            ]
        },
        title_highlight: '<em>MCP</em> 入门教程',
        content_highlight: '这是<em>高亮</em>内容 &amp; 更多'
    }
];

describe('parseJuejinResults', () => {
    it('should map API items to SearchResult with cleaned highlights', () => {
        const results = parseJuejinResults(DATA as never);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            title: 'MCP 入门教程',
            url: 'https://juejin.cn/post/7412345678901234567',
            source: '作者甲',
            engine: 'juejin'
        });
        expect(results[0].description).toBe('这是高亮内容 & 更多 | 分类: 前端 | 标签: React, MCP | 👍 34 | 👀 120');
    });

    it('should handle empty data array', () => {
        expect(parseJuejinResults([])).toEqual([]);
    });
});

describe('highlightToText', () => {
    it('should strip em tags and decode entities', () => {
        expect(highlightToText('<em>重点</em> &#34;quoted&#34;')).toBe('重点 "quoted"');
    });

    it('should return empty string for empty input', () => {
        expect(highlightToText('')).toBe('');
        expect(highlightToText(undefined as never)).toBe('');
    });
});

describe('parseJuejinResults 容错（上游字段缺失）', () => {
    it('单条结果缺 tags/category/author 时不应抛错（实测 tags.map 曾抛 TypeError 拖垮整个引擎）', () => {
        const data = [
            {
                result_type: 0,
                result_model: { article_id: '123', article_info: { digg_count: 1, view_count: 2 } },
                title_highlight: '标题',
                content_highlight: '摘要'
            }
        ] as never;

        const results = parseJuejinResults(data);

        expect(results).toHaveLength(1);
        expect(results[0].url).toBe('https://juejin.cn/post/123');
        expect(results[0].source).toBe('');
        expect(results[0].description).toContain('标签: ');
    });

    it('data 不是数组时返回空数组（不再抛 reading map）', () => {
        expect(parseJuejinResults(undefined as never)).toEqual([]);
        expect(parseJuejinResults({} as never)).toEqual([]);
    });
});
