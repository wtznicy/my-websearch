import { describe, expect, it } from 'vitest';
import { relaxStackOverflowQueries } from '../../engines/stackoverflow/stackoverflow.js';
import { stripGithubIntentPhrases, formatRepoItem } from '../../engines/github/githubSearch.js';

/**
 * 质量回归：
 * - SO 的 `q` 是全词 AND，比较词会把结果卡成 0 条（实测 "asyncio gather vs create_task difference"）
 * - GitHub 直接把 "asyncio best practices" 丢给仓库搜索，只会命中描述里恰好有这些词的低星仓库
 */
describe('stackoverflow query relaxation', () => {
    it('keeps the original query first', () => {
        expect(relaxStackOverflowQueries('asyncio gather vs create_task')[0]).toBe('asyncio gather vs create_task');
    });

    it('drops comparison words so the AND query can match', () => {
        const candidates = relaxStackOverflowQueries('asyncio gather vs create_task difference');
        // 实测该查询在 StackExchange 上 0 条；去掉 vs/difference 后应能命中
        expect(candidates).toContain('asyncio gather create_task');
        expect(candidates.some((q) => !/\bvs\b/i.test(q))).toBe(true);
    });

    it('produces identifier-only fallbacks', () => {
        const candidates = relaxStackOverflowQueries('how to use asyncio gather');
        expect(candidates.some((q) => q === 'asyncio gather')).toBe(true);
    });
});

describe('github intent-phrase stripping', () => {
    it('strips conceptual phrases for the widened search', () => {
        expect(stripGithubIntentPhrases('asyncio best practices')).toBe('asyncio');
        expect(stripGithubIntentPhrases('python asyncio tutorial')).toBe('python asyncio');
    });

    it('down-ranks low-star repositories instead of surfacing them first', () => {
        const low = formatRepoItem({ full_name: 'a/b', html_url: 'https://github.com/a/b', stargazers_count: 2 } as never);
        const high = formatRepoItem({ full_name: 'c/d', html_url: 'https://github.com/c/d', stargazers_count: 5000 } as never);
        expect(low.rankBoost).toBe(-25);
        expect(high.rankBoost).toBeUndefined();
    });
});
