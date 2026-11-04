import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { normalizeEngineName } from '../../tools/setupTools.js';

const SUPPORTED_ENGINES = [
    'baidu',
    'bing',
    'bing-news',
    'csdn',
    'duckduckgo',
    'exa',
    'brave',
    'juejin',
    'startpage',
    'yahoo',
    'sogou',
    'github',
    'stackoverflow',
    'hackernews',
    'arxiv',
    'code'
] as const;

const engineSchema = z.array(
    z.string()
        .min(1)
        .transform(normalizeEngineName)
        .pipe(z.enum(SUPPORTED_ENGINES))
).min(1);

describe('engine name normalization (tool schema)', () => {
    it.each([
        [['bing'], ['bing']],
        [['Bing'], ['bing']],
        [['DuckDuckGo'], ['duckduckgo']],
        [['duck-duck-go'], ['duckduckgo']],
        [['  CSDN  ', 'JueJin'], ['csdn', 'juejin']],
        [['StartPage'], ['startpage']],
        [['SouGou'], ['sogou']],
        [['sou-gou'], ['sogou']],
        [['搜狗'], ['sogou']]
    ])('accepts %j and normalizes to %j', (input, expected) => {
        expect(engineSchema.parse(input)).toEqual(expected);
    });

    it.each([
        [['Google']],
        [['']]
    ])('rejects unsupported engine list %j', (input) => {
        expect(engineSchema.safeParse(input).success).toBe(false);
    });
});
