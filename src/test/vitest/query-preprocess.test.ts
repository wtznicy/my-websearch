import { describe, it, expect } from 'vitest';
import {
    quoteModelLikeTerms,
    quoteTechnicalTerms,
    preprocessSearchQuery,
    cleanStackTraceNoise
} from '../../utils/queryPreprocess.js';

describe('utils/queryPreprocess quoteModelLikeTerms', () => {
    it('quotes hyphenated model/version tokens with digits', () => {
        expect(quoteModelLikeTerms('GLM-4.6V-Flash')).toBe('"GLM-4.6V-Flash"');
        expect(quoteModelLikeTerms('GLM-4V-Flash')).toBe('"GLM-4V-Flash"');
        expect(quoteModelLikeTerms('DeepSeek-V4')).toBe('"DeepSeek-V4"');
        expect(quoteModelLikeTerms('GPT-4o')).toBe('"GPT-4o"');
    });

    it('keeps surrounding words intact', () => {
        expect(quoteModelLikeTerms('GLM-4.6V-Flash 官方文档')).toBe('"GLM-4.6V-Flash" 官方文档');
        expect(quoteModelLikeTerms('硅基流动 GLM-4.6V-Flash 免费')).toBe('硅基流动 "GLM-4.6V-Flash" 免费');
    });

    it('handles site: operators without quoting domains', () => {
        expect(quoteModelLikeTerms('site:docs.bigmodel.cn GLM-4.6V-Flash')).toBe('site:docs.bigmodel.cn "GLM-4.6V-Flash"');
        expect(quoteModelLikeTerms('update site:docs.elastic.co')).toBe('update site:docs.elastic.co');
    });

    it('leaves non-model text and existing quotes unchanged', () => {
        expect(quoteModelLikeTerms('docs.bigmodel.cn')).toBe('docs.bigmodel.cn');
        expect(quoteModelLikeTerms('硅基流动 免费模型')).toBe('硅基流动 免费模型');
        expect(quoteModelLikeTerms('hello world')).toBe('hello world');
        expect(quoteModelLikeTerms('"GLM-4.6V-Flash" 文档')).toBe('"GLM-4.6V-Flash" 文档');
    });
});

describe('utils/queryPreprocess quoteTechnicalTerms', () => {
    it('quotes framework/library names and uppercase technical acronyms', () => {
        expect(quoteTechnicalTerms('Vitest 5 Node.js 22 configuration'))
            .toBe('"Vitest" 5 "Node.js" 22 configuration');
        expect(quoteTechnicalTerms('MCP specification')).toBe('"MCP" specification');
        expect(quoteTechnicalTerms('Next.js 15 Hydration failed')).toBe('"Next.js" 15 Hydration failed');
        expect(quoteTechnicalTerms('中文 Vitest 教程')).toBe('中文 "Vitest" 教程');
    });

    it('quotes camelCase names while keeping common uppercase English unquoted', () => {
        expect(quoteTechnicalTerms('SpringBoot Playwright')).toBe('"SpringBoot" "Playwright"');
        expect(quoteTechnicalTerms('NEW TOP FEATURES')).toBe('NEW TOP FEATURES');
    });

    it('does not double quote if query already has quotes', () => {
        expect(quoteTechnicalTerms('"Vitest" configuration')).toBe('"Vitest" configuration');
    });
});

describe('utils/queryPreprocess preprocessSearchQuery pipeline', () => {
    it('cleans stack trace noise and quotes technical terms', () => {
        const noisy = 'Error at D:\\Desktop\\app.ts:142:18 Vitest test failed';
        const processed = preprocessSearchQuery(noisy);
        expect(processed).toContain('"Vitest"');
        expect(processed).not.toContain('D:\\Desktop');
    });
});
