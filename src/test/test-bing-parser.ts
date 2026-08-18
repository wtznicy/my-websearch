import { __analyzeBlockedPageForTests, __buildBingBrowserLaunchArgsForTests, hasSiteOperator, shouldSuggestRemovingSiteOperator } from '../engines/bing/bing.js';
import { parseBingSearchResults } from '../engines/bing/parser.js';
import * as cheerio from 'cheerio';

function assert(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

const classicHtml = `
<div id="b_content">
  <ol id="b_results">
    <li class="b_algo">
      <h2><a href="https://example.com/article?utm_source=bing">Example Result</a></h2>
      <div class="b_caption"><p>Classic Bing result snippet.</p></div>
      <div class="b_attribution"><cite>example.com</cite></div>
    </li>
  </ol>
</div>`;

const modernHtml = `
<ol id="b_results">
  <li class="b_algo">
    <div class="b_tpcn">
      <a class="tilk" href="https://docs.example.org/guide"><span class="tptt">Docs Guide</span></a>
    </div>
    <div class="b_snippet">Modern Bing layout snippet.</div>
  </li>
</ol>`;

const fallbackHtml = `
<div id="b_results">
  <div class="b_algo">
    <a href="https://fallback.example.dev/path">Fallback title</a>
  </div>
</div>`;

const classicResults = parseBingSearchResults(classicHtml, 5);
assert(classicResults.length === 1, 'classic layout should yield one result');
assert(classicResults[0].title === 'Example Result', 'classic layout title should parse');
assert(classicResults[0].url === 'https://example.com/article', 'tracking params should be stripped');
assert(classicResults[0].description.includes('Classic Bing result snippet'), 'classic layout snippet should parse');

const modernResults = parseBingSearchResults(modernHtml, 5);
assert(modernResults.length === 1, 'modern layout should yield one result');
assert(modernResults[0].title === 'Docs Guide', 'modern layout title should parse');
assert(modernResults[0].url === 'https://docs.example.org/guide', 'modern layout url should parse');

const fallbackResults = parseBingSearchResults(fallbackHtml, 5);
assert(fallbackResults.length === 1, 'fallback layout should yield one result');
assert(fallbackResults[0].title === 'Fallback title', 'fallback link title should parse');
assert(fallbackResults[0].url === 'https://fallback.example.dev/path', 'fallback link url should parse');

// 回归测试：新版结果页的 .b_tpcn 里同时有站点名（.tptt）和可见 URL slug 文本节点，
// extractSource 若取整个 .b_tpcn 的 text()，会把两者无分隔拼成 "zhihu.comhttps://zhuanlan.zhihu.com"。
const sourceConcatHtml = `
<ol id="b_results">
  <li class="b_algo">
    <div class="b_tpcn">
      <a class="tilk" href="https://zhuanlan.zhihu.com/p/29001189476"><span class="tptt">zhihu.com</span></a>
      <div class="b_attribution" aria-label="zhuanlan.zhihu.com/p/29001189476">https://zhuanlan.zhihu.com</div>
    </div>
    <h2><a href="https://zhuanlan.zhihu.com/p/29001189476">MCP（Model Context Protocol）一篇就够了</a></h2>
    <div class="b_snippet">A snippet.</div>
  </li>
</ol>`;
const sourceResults = parseBingSearchResults(sourceConcatHtml, 5);
assert(sourceResults.length === 1, 'source regression fixture should yield one result');
assert(sourceResults[0].source === 'zhihu.com', 'source should be the .tptt site name, not concatenated with the URL slug');
assert(!sourceResults[0].source.includes('https://'), 'source must not contain a concatenated URL');

assert(hasSiteOperator('site:blink.new blink.new') === true, 'site operator should be detected');
assert(hasSiteOperator('blink.new AI App Builder') === false, 'plain query should not be treated as site-restricted');
assert(
    shouldSuggestRemovingSiteOperator(
        'site:blink.new blink.new',
        new Error('page.waitForSelector: Timeout 15000ms exceeded.')
    ) === true,
    'site-restricted timeout should suggest removing site operator'
);
assert(
    shouldSuggestRemovingSiteOperator(
        'blink.new AI App Builder',
        new Error('page.waitForSelector: Timeout 15000ms exceeded.')
    ) === false,
    'plain timeout should not suggest removing site operator'
);

function assertWindowsLaunchArgsDoNotUseUnsupportedFlags(args: string[], label: string): void {
  for (const arg of args) {
    assert(!arg.startsWith('--disable-'), `${label} should not include unsupported disable flag: ${arg}`);
    assert(arg !== '--no-sandbox', `${label} should not disable browser sandbox`);
    assert(arg !== '--no-zygote', `${label} should not include Linux zygote flag`);
  }
}

const windowsLaunchArgs = __buildBingBrowserLaunchArgsForTests(false, 'win32');
assertWindowsLaunchArgsDoNotUseUnsupportedFlags(windowsLaunchArgs, 'Windows headed launch args');

const windowsHiddenLaunchArgs = __buildBingBrowserLaunchArgsForTests(true, 'win32');
assertWindowsLaunchArgsDoNotUseUnsupportedFlags(windowsHiddenLaunchArgs, 'Windows hidden-headed launch args');
assert(windowsHiddenLaunchArgs.includes('--window-position=-32000,-32000'), 'Windows hidden-headed launch args should keep off-screen position');
assert(windowsHiddenLaunchArgs.includes('--window-size=1,1'), 'Windows hidden-headed launch args should keep hidden window size');

const linuxLaunchArgs = __buildBingBrowserLaunchArgsForTests(false, 'linux');
assert(linuxLaunchArgs.includes('--no-sandbox'), 'Linux launch args should keep root-compatible sandbox bypass');
assert(linuxLaunchArgs.includes('--disable-setuid-sandbox'), 'Linux launch args should keep setuid sandbox bypass');
assert(linuxLaunchArgs.includes('--disable-web-security'), 'Linux launch args should keep existing anti-detection compatibility flags');

// /ck/a 跳转链接解析测试
const ckRedirectHtml = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from('https://real-target.example.com/page').toString('base64url')}&ntb=1">CK Redirect Result</a></h2>
    <div class="b_caption"><p>Result behind /ck/a redirect.</p></div>
  </li>
</ol>`;
const ckResults = parseBingSearchResults(ckRedirectHtml, 5);
assert(ckResults.length === 1, '/ck/a redirect should yield one result');
assert(ckResults[0].url === 'https://real-target.example.com/page', '/ck/a redirect target should be decoded from base64url u param');
assert(ckResults[0].title === 'CK Redirect Result', '/ck/a result title should parse');

// 固定相对 /ck/a 的当前行为：这类链接没有可信 origin，上游解析器会按 Bing 内部跳转丢弃，避免返回不可点击的相对 URL。
const relativeCkRedirectHtml = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="/ck/a?!&&p=abc&u=a1${Buffer.from('https://relative-target.example.com/page').toString('base64url')}&ntb=1">Relative CK Redirect Result</a></h2>
    <div class="b_caption"><p>Relative /ck/a redirect should be ignored.</p></div>
  </li>
</ol>`;
const relativeCkResults = parseBingSearchResults(relativeCkRedirectHtml, 5);
assert(relativeCkResults.length === 0, 'relative /ck/a redirect should be discarded as an internal Bing jump link');

// ---------------------------------------------------------------------------
// analyzeBlockedPage 轻量级选择器检查测试
// ---------------------------------------------------------------------------

function testAnalyzeBlockedPage(): void {
    // 正常结果页：有结构化结果 → not blocked
    const normalHtml = `<html><head><title>Bing</title></head><body>
        <ol id="b_results">
            <li class="b_algo"><h2><a href="https://example.com">Result</a></h2></li>
        </ol>
    </body></html>`;
    const $normal = cheerio.load(normalHtml);
    const normalState = __analyzeBlockedPageForTests($normal, normalHtml);
    assert(normalState.hasResults === true, 'normal page with .b_algo should detect results');
    assert(normalState.blocked === false, 'normal page should not be blocked');

    // 无结构化结果但有回退链接 → hasResults = true, not blocked
    const fallbackHtml = `<html><head><title>Bing</title></head><body>
        <div id="b_results">
            <a href="https://fallback.example.com">Fallback Link</a>
        </div>
    </body></html>`;
    const $fallback = cheerio.load(fallbackHtml);
    const fallbackState = __analyzeBlockedPageForTests($fallback, fallbackHtml);
    assert(fallbackState.hasResults === true, 'page with fallback links should detect results');
    assert(fallbackState.blocked === false, 'page with fallback links should not be blocked');

    // 验证码页面：有 captcha 关键词 + 无结果 → blocked
    const captchaHtml = `<html><head><title>Please verify you are human</title></head><body>
        <div id="b_captcha">CAPTCHA</div>
    </body></html>`;
    const $captcha = cheerio.load(captchaHtml);
    const captchaState = __analyzeBlockedPageForTests($captcha, captchaHtml);
    assert(captchaState.hasResults === false, 'captcha page should have no results');
    assert(captchaState.blocked === true, 'captcha page should be blocked');
    assert(captchaState.title.includes('verify you are human'), 'should detect captcha title');

    // 空页面：无结果无 captcha → not blocked（可能是正常空结果）
    const emptyHtml = `<html><head><title>Bing</title></head><body></body></html>`;
    const $empty = cheerio.load(emptyHtml);
    const emptyState = __analyzeBlockedPageForTests($empty, emptyHtml);
    assert(emptyState.hasResults === false, 'empty page should have no results');
    assert(emptyState.blocked === false, 'empty page without captcha signals should not be blocked');

    console.log('✅ analyzeBlockedPage lightweight selector check');
}

testAnalyzeBlockedPage();

console.log('Bing parser tests passed.');
