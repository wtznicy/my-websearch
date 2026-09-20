import { describe, it, expect } from 'vitest';
import { pickDefaultEngineForQuery } from '../../core/search/queryEngineRouting.js';

describe('pickDefaultEngineForQuery', () => {
    it('should keep the configured engine when not "auto"', () => {
        expect(pickDefaultEngineForQuery('任何查询', 'sogou')).toBe('sogou');
        expect(pickDefaultEngineForQuery('hello world', 'bing')).toBe('bing');
    });

    it('should route Chinese natural-language queries to baidu in auto mode', () => {
        expect(pickDefaultEngineForQuery('量化宽松政策是什么', 'auto')).toBe('baidu');
        expect(pickDefaultEngineForQuery('最近有什么好看的电影', 'auto')).toBe('baidu');
        expect(pickDefaultEngineForQuery('红烧肉的做法', 'auto')).toBe('baidu');
    });

    it('should route English queries to bing in auto mode', () => {
        expect(pickDefaultEngineForQuery('hello world', 'auto')).toBe('bing');
        expect(pickDefaultEngineForQuery('best javascript framework', 'auto')).toBe('bing');
    });

    it('should route CJK-containing queries to baidu regardless of latin technical terms', () => {
        // 实测：中文技术查询（含英文技术词）在国内引擎召回质量显著更好
        expect(pickDefaultEngineForQuery('DeepSeek Harness MCP 配置', 'auto')).toBe('baidu');
        expect(pickDefaultEngineForQuery('RAG 检索增强生成 原理', 'auto')).toBe('baidu');
        expect(pickDefaultEngineForQuery('React useEffect 依赖数组', 'auto')).toBe('baidu');
        expect(pickDefaultEngineForQuery('怎么用 npm install 装包', 'auto')).toBe('baidu');
        expect(pickDefaultEngineForQuery('TypeScript 泛型', 'auto')).toBe('baidu');
    });

    it('should route a single CJK char (likely noise) to bing', () => {
        expect(pickDefaultEngineForQuery('react tutorial 中', 'auto')).toBe('bing');
    });

    it('should fall back to bing for empty queries', () => {
        expect(pickDefaultEngineForQuery('', 'auto')).toBe('bing');
        expect(pickDefaultEngineForQuery('   ', 'auto')).toBe('bing');
    });
});
