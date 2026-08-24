import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from '../../config.js';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { assertOverseasEngineUsable } from '../../utils/overseasProbe.js';

const STARTPAGE_BASE_URL = 'https://www.startpage.com';
const STARTPAGE_SEARCH_URL = `${STARTPAGE_BASE_URL}/sp/search`;
const STARTPAGE_SC_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 10;

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
};

let cachedScCode: string | undefined;
let cachedCookies: string | undefined;
let cachedScAt = 0;

function isCaptchaPage(html: string): boolean {
    const normalized = html.toLowerCase();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim().toLowerCase();

    if (normalized.includes('/sp/captcha')) {
        return true;
    }

    const hasCaptchaUi = $([
        'form[action*="/sp/captcha"]',
        'iframe[src*="captcha"]',
        '[id*="captcha"]',
        '[class*="captcha"]'
    ].join(',')).length > 0;

    const hasVerificationText = [
        'verify you are human',
        'human verification',
        'security check'
    ].some((keyword) => normalized.includes(keyword) || title.includes(keyword));

    return hasCaptchaUi || hasVerificationText;
}

function extractScCode(html: string): string | undefined {
    const $ = cheerio.load(html);
    return $('form[action="/sp/search"] input[name="sc"]').first().attr('value')?.trim() || undefined;
}

function extractInterstitialPayload(html: string): Record<string, string> | undefined {
    const match = html.match(/var data = (\{[\s\S]*?\});/);
    if (!match) {
        return undefined;
    }

    try {
        const payload = JSON.parse(match[1]) as Record<string, unknown>;
        if (typeof payload?.query !== 'string' || typeof payload?.sgt !== 'string') {
            return undefined;
        }

        const data = Object.entries(payload).reduce<Record<string, string>>((acc, [key, value]) => {
            if (typeof value === 'string') {
                acc[key] = value;
            }
            return acc;
        }, {});

        return Object.keys(data).length > 0 ? data : undefined;
    } catch {
        return undefined;
    }
}

// startpage 自 2025 年起部署 Anubis 反爬（proof-of-work + JS 执行，专防 AI/LLM 爬虫），
// 纯 HTTP 请求无法获取搜索 token（返回 "Verifying your request..." 或 "Startpage Blocked"）。
// 实测 headless 模式会被 startpage 直接屏蔽（返回 captcha-block 页 "Startpage Blocked"），
// 只有 headed/hidden-headed（隐藏有头）模式能完成 Anubis 挑战拿到搜索表单。
// 方案：用 Playwright hidden-headed 模式打开首页完成 Anubis 挑战，
// 提取放行 cookie（spchal-auth 等）+ sc token 并缓存复用；cookie 失效时重新预热。
async function warmupStartpageSession(): Promise<void> {
    // STARTPAGE_PLAYWRIGHT_FALLBACK=false：不启动浏览器（hidden-headed 预热约 400MB 内存 +
    // 秒级延迟），HTTP 被反爬直接报错，配合 minResults 级联自动换引擎。
    if (!config.startpagePlaywrightFallback) {
        throw new Error('Startpage requires a Playwright browser session (Anubis anti-bot), but STARTPAGE_PLAYWRIGHT_FALLBACK=false. Enable the fallback, or use another engine (e.g. bing/baidu/sogou).');
    }
    let session: { browser: any; release(): Promise<void> } | undefined;
    let releasePage: (() => Promise<void>) | undefined;
    try {
        const { openPlaywrightBrowser, acquirePooledPlaywrightPage } = await import('../../utils/playwrightClient.js');
        const { prepareStealthPage } = await import('../../utils/browserStealth.js');

        // 复用项目统一的 Playwright 基础设施（openPlaywrightBrowser + 页面池 + stealth 反检测），
        // 自动处理：浏览器路径/WS/CDP 端点、按引擎代理、指纹伪装。
        // 注意：playwright 1.62+ 已移除 page.setUserAgent，需通过 contextOptions.userAgent 设置。
        // startpage 会屏蔽 headless 浏览器，必须用 hidden-headed（隐藏有头）模式打开。
        session = await openPlaywrightBrowser(false, [], { hideWindow: true });
        const pooled = await acquirePooledPlaywrightPage(session.browser, {
            poolKey: 'startpage-warmup',
            contextOptions: {
                userAgent: COMMON_HEADERS['User-Agent'],
                locale: 'en-US',
                viewport: { width: 1920, height: 1080 }
            },
            preparePage: prepareStealthPage
        });
        releasePage = pooled.releasePage;
        const page = pooled.page;
        await page.goto(`${STARTPAGE_BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // 等待 Anubis PoW 完成：搜索表单出现即放行
        await page.waitForSelector('form[action="/sp/search"]', { timeout: 30000 });
        const scCode = await page.locator('form[action="/sp/search"] input[name="sc"]').first()
            .getAttribute('value')
            .catch(() => null);
        if (!scCode) {
            throw new Error('Failed to extract Startpage search token after Anubis challenge');
        }
        const cookies = await page.context().cookies(STARTPAGE_BASE_URL);
        const cookieStr = cookies.map((cookie: { name: string; value: string }) => `${cookie.name}=${cookie.value}`).join('; ');
        if (!cookieStr) {
            throw new Error('Failed to extract Startpage session cookies after Anubis challenge');
        }
        cachedScCode = scCode;
        cachedCookies = cookieStr;
        cachedScAt = Date.now();
    } finally {
        if (releasePage) {
            await releasePage().catch(() => undefined);
        }
        if (session) {
            await session.release().catch(() => undefined);
        }
    }
}

async function getScCode(): Promise<string> {
    const now = Date.now();
    if (cachedScCode && now - cachedScAt < STARTPAGE_SC_TTL_MS) {
        return cachedScCode;
    }
    await warmupStartpageSession();
    if (!cachedScCode) {
        throw new Error('Failed to extract Startpage search token');
    }
    return cachedScCode;
}

export function extractResultsFromHtml(html: string): SearchResult[] {
    if (isCaptchaPage(html)) {
        throw new Error('Startpage returned a verification or anti-bot page');
    }

    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    $('a.result-title.result-link[href]').each((_, element) => {
        const link = $(element);
        const url = link.attr('href')?.trim();
        const title = link.find('h2').first().text().replace(/\s+/g, ' ').trim();
        const description = link.nextAll('p.description').first().text().replace(/\s+/g, ' ').trim();

        if (!url || !title || seenUrls.has(url)) {
            return;
        }
        seenUrls.add(url);

        let source = '';
        try {
            source = new URL(url).hostname;
        } catch {
            source = '';
        }

        results.push({
            title,
            url,
            description,
            source,
            engine: 'startpage'
        });
    });

    return results;
}

async function searchStartpagePage(query: string, page: number): Promise<SearchResult[]> {
    const scCode = await getScCode();
    const formData = new URLSearchParams({
        query,
        cat: 'web',
        t: 'device',
        sc: scCode,
        abp: '1',
        abd: '1',
        abe: '1'
    });

    if (page > 1) {
        formData.set('page', String(page));
        formData.set('segment', 'startpage.udog');
    }

    const response = await axios.post(
        STARTPAGE_SEARCH_URL,
        formData.toString(),
        buildAxiosRequestOptions({ engine: 'startpage',
            trustedStaticHost: true,
            headers: {
                ...COMMON_HEADERS,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': STARTPAGE_BASE_URL,
                'Referer': `${STARTPAGE_BASE_URL}/`,
                ...(cachedCookies ? { 'Cookie': cachedCookies } : {})
            },
            timeout: 20000
        })
    );

    let html = String(response.data || '');
    const interstitialPayload = extractInterstitialPayload(html);
    if (interstitialPayload) {
        const followUpResponse = await axios.post(
            STARTPAGE_SEARCH_URL,
            new URLSearchParams(interstitialPayload).toString(),
            buildAxiosRequestOptions({ engine: 'startpage',
                trustedStaticHost: true,
                headers: {
                    ...COMMON_HEADERS,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': STARTPAGE_BASE_URL,
                    'Referer': STARTPAGE_SEARCH_URL,
                    ...(cachedCookies ? { 'Cookie': cachedCookies } : {})
                },
                timeout: 20000
            })
        );

        html = String(followUpResponse.data || '');
    }

    return extractResultsFromHtml(html);
}

export async function searchStartpage(query: string, limit: number): Promise<SearchResult[]> {
    // 未配置代理时先探测直连可达性：不可达立即报"需要代理"，避免直连挂超时拖累整次搜索
    await assertOverseasEngineUsable('startpage');
    const allResults: SearchResult[] = [];
    const seenUrls = new Set<string>();
    const maxPage = Math.max(1, Math.ceil(limit / DEFAULT_PAGE_SIZE));

    for (let page = 1; page <= maxPage && allResults.length < limit; page += 1) {
        const pageResults = await searchStartpagePage(query, page);
        for (const result of pageResults) {
            if (seenUrls.has(result.url)) {
                continue;
            }
            seenUrls.add(result.url);
            allResults.push(result);
        }

        if (pageResults.length === 0) {
            break;
        }
    }

    return allResults.slice(0, limit);
}
