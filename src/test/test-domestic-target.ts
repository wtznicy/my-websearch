import { isDomesticTargetUrl } from '../utils/httpRequest.js';

function assertEqual(actual: boolean, expected: boolean, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

// 国内站点：.cn 后缀或名单内域名 → 直连（true = 不走代理）
assertEqual(isDomesticTargetUrl('https://blog.csdn.net/x/article'), true, 'csdn is domestic');
assertEqual(isDomesticTargetUrl('https://docs.bigmodel.cn/cn/guide'), true, '.cn domain is domestic');
assertEqual(isDomesticTargetUrl('https://www.gitee.com/wtznicy'), true, 'gitee is domestic');
assertEqual(isDomesticTargetUrl('https://juejin.cn/post/1'), true, 'juejin is domestic');
assertEqual(isDomesticTargetUrl('https://www.zhihu.com/question/1'), true, 'zhihu is domestic');

// 海外站点 → 走代理（false）
assertEqual(isDomesticTargetUrl('https://docs.siliconflow.com/x'), false, 'siliconflow is overseas');
assertEqual(isDomesticTargetUrl('https://www.bing.com/search'), false, 'bing is overseas');
assertEqual(isDomesticTargetUrl('https://github.com/a/b'), false, 'github is overseas');
assertEqual(isDomesticTargetUrl('https://example.com'), false, 'example is overseas');

// 非法 URL → 非国内（不误判）
assertEqual(isDomesticTargetUrl('not a url'), false, 'invalid url is not domestic');

console.log('✅ isDomesticTargetUrl: all cases passed');
