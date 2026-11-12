import { describe, expect, it } from 'vitest';
import { renderSearchBriefMarkdown } from '../../tools/handlers/searchMarkdownBrief.js';

describe('renderSearchBriefMarkdown', () => {
    it('renders clean structured markdown brief when top articles have fullContent', () => {
        const markdown = renderSearchBriefMarkdown({
            query: 'FastAPI 最佳实践',
            engines: ['baidu', 'bing'],
            outcome: 'ok',
            totalResults: 2,
            results: [
                {
                    title: 'FastAPI 项目结构化开发指南',
                    url: 'https://cloud.baidu.com/article/123',
                    source: 'cloud.baidu.com',
                    date: '2025-01-15',
                    fullContent: '## 核心目录\n\n```python\nfrom fastapi import FastAPI\n```\n\n推荐拆分 routers。'
                },
                {
                    title: 'FastAPI 最佳架构实践',
                    url: 'https://blog.csdn.net/article/456',
                    source: 'blog.csdn.net',
                    date: '2024-10-21',
                    fullContent: '## 架构演化\n\nDDD 模式在 FastAPI 中的落地。'
                }
            ]
        });

        expect(markdown).toContain('# 检索研报: FastAPI 最佳实践');
        expect(markdown).toContain('## 来源清单 (Sources)');
        expect(markdown).toContain('1. [FastAPI 项目结构化开发指南](https://cloud.baidu.com/article/123) · *cloud.baidu.com* (2025-01-15)');
        expect(markdown).toContain('## 核心正文 (Top Documents)');
        expect(markdown).toContain('### [1] FastAPI 项目结构化开发指南');
        expect(markdown).toContain('```python\nfrom fastapi import FastAPI\n```');
        expect(markdown).toContain('### [2] FastAPI 最佳架构实践');
    });

    it('renders additional results when only top N have fullContent', () => {
        const markdown = renderSearchBriefMarkdown({
            query: 'Gin tutorial',
            engines: ['bing'],
            outcome: 'ok',
            totalResults: 3,
            results: [
                {
                    title: 'Gin Web Framework',
                    url: 'https://gin-gonic.com',
                    fullContent: 'Welcome to Gin.'
                },
                {
                    title: 'Gin GitHub',
                    url: 'https://github.com/gin-gonic/gin',
                    description: 'HTTP web framework written in Go.'
                }
            ]
        });

        expect(markdown).toContain('## 核心正文 (Top Documents)');
        expect(markdown).toContain('### [1] Gin Web Framework');
        expect(markdown).toContain('## 补充参考条目 (Additional Results)');
        expect(markdown).toContain('- **[2] [Gin GitHub](https://github.com/gin-gonic/gin)**');
        expect(markdown).toContain('HTTP web framework written in Go.');
    });

    it('renders directAnswer and partial failure notes if present', () => {
        const markdown = renderSearchBriefMarkdown({
            query: 'Weather today',
            engines: ['bing'],
            outcome: 'degraded',
            totalResults: 1,
            results: [{ title: 'Sunny', url: 'https://weather.com' }],
            directAnswer: 'Today is sunny and 22C.',
            partialFailures: [{ engine: 'baidu', message: 'timeout' }]
        });

        expect(markdown).toContain('## 概览解答 (Direct Answer)');
        expect(markdown).toContain('Today is sunny and 22C.');
        expect(markdown).toContain('部分引擎未响应: baidu (timeout)');
    });
});
