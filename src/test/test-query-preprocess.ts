import { quoteModelLikeTerms } from '../utils/queryPreprocess.js';

function assertEqual(actual: string, expected: string, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected "${expected}", got "${actual}"`);
    }
}

// 型号/版本类查询：含数字的连字符/点号紧凑串加引号
assertEqual(quoteModelLikeTerms('GLM-4.6V-Flash'), '"GLM-4.6V-Flash"', 'hyphenated model with digits');
assertEqual(quoteModelLikeTerms('GLM-4V-Flash'), '"GLM-4V-Flash"', 'short model');
assertEqual(quoteModelLikeTerms('DeepSeek-V4'), '"DeepSeek-V4"', 'letter-digit hyphen');
assertEqual(quoteModelLikeTerms('GPT-4o'), '"GPT-4o"', 'gpt style');
assertEqual(quoteModelLikeTerms('GLM-4.6V-Flash 官方文档'), '"GLM-4.6V-Flash" 官方文档', 'model plus chinese words');
assertEqual(quoteModelLikeTerms('硅基流动 GLM-4.6V-Flash 免费'), '硅基流动 "GLM-4.6V-Flash" 免费', 'mixed query');

// site: 操作符组合：域名不加引号、型号加引号
assertEqual(quoteModelLikeTerms('site:docs.bigmodel.cn GLM-4.6V-Flash'), 'site:docs.bigmodel.cn "GLM-4.6V-Flash"', 'site: operator with model');
assertEqual(quoteModelLikeTerms('update site:docs.elastic.co'), 'update site:docs.elastic.co', 'domain-only site: unchanged');

// 不误伤：无数字域名、纯中文、已有引号
assertEqual(quoteModelLikeTerms('docs.bigmodel.cn'), 'docs.bigmodel.cn', 'domain without digits unchanged');
assertEqual(quoteModelLikeTerms('硅基流动 免费模型'), '硅基流动 免费模型', 'pure chinese unchanged');
assertEqual(quoteModelLikeTerms('hello world'), 'hello world', 'plain words unchanged');
assertEqual(quoteModelLikeTerms('"GLM-4.6V-Flash" 文档'), '"GLM-4.6V-Flash" 文档', 'existing quotes preserved');

console.log('✅ quoteModelLikeTerms: all cases passed');
