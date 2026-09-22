import * as crypto from 'node:crypto';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';

/**
 * Startpage Anubis 反爬的纯 Node 求解器（无浏览器）。
 *
 * 背景：Startpage 自 2025 年起部署 Anubis WAF（Proof-of-Work 挑战）——纯 HTTP 请求
 * 拿到的是 `<script id="anubis_challenge">` 挑战页（"Verifying your request..."），
 * 之前的方案是启动 Playwright（hidden-headed）跑通挑战，代价约 10s + 400MB 内存。
 *
 * Anubis 的 PoW 本质是 `SHA256(randomData + nonce)` 前缀满足 difficulty 个 0——
 * 在 Node 原生 crypto 里只需百毫秒级（实测 difficulty=4 约 150ms），因此可以：
 *   1. GET 首页 → 解析挑战 payload 与 Set-Cookie（spchal-cookie-verification）
 *   2. 本地 PoW 求解
 *   3. GET pass-challenge（带 cookie）→ 302 + spchal-auth（JWT，有效期 5 分钟）
 *   4. 带全部 cookie 再取首页 → 搜索表单的 sc token
 *
 * 实测 Anubis v1.26.4：全流程约 2.6 秒。失败（协议变更/IP 信誉加重难度）时返回 null，
 * 由调用方回退 Playwright 兜底。
 */

const STARTPAGE_BASE_URL = 'https://www.startpage.com';
const ANUBIS_PASS_PATH = '/.within.website/x/cmd/anubis/api/pass-challenge';
/** PoW 迭代上限（difficulty 正常为 4~6；被标记 IP 可能升高，超限时回退浏览器） */
const POW_MAX_NONCE = 20_000_000;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

export type AnubisSession = {
    /** 放行后的完整 Cookie 串（spchal-cookie-verification + spchal-auth 等） */
    cookies: string;
    /** 搜索表单的 sc token */
    scCode: string;
};

/** 求解 Anubis PoW：找 nonce 使 sha256(randomData + nonce) 以 difficulty 个 '0' 开头 */
export function solveAnubisPow(randomData: string, difficulty: number): { nonce: number; hash: string } | null {
    const prefix = '0'.repeat(Math.max(1, Math.min(Math.floor(difficulty) || 1, 8)));
    for (let nonce = 0; nonce < POW_MAX_NONCE; nonce += 1) {
        const hash = crypto.createHash('sha256').update(`${randomData}${nonce}`).digest('hex');
        if (hash.startsWith(prefix)) {
            return { nonce, hash };
        }
    }
    return null;
}

/** 从挑战页 HTML 解析 Anubis payload（challenge.id / randomData / rules.difficulty） */
export function parseAnubisChallenge(html: string): { id: string; randomData: string; difficulty: number } | null {
    const match = html.match(/id="anubis_challenge"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) {
        return null;
    }
    try {
        const payload = JSON.parse(match[1].trim()) as {
            rules?: { difficulty?: number };
            challenge?: { id?: string; randomData?: string };
        };
        const id = payload.challenge?.id;
        const difficulty = payload.rules?.difficulty;
        if (typeof id !== 'string' || typeof difficulty !== 'number') {
            return null;
        }
        // randomData 是 PoW 输入；缺失时退回 id（早期版本行为）
        return { id, randomData: String(payload.challenge?.randomData ?? id), difficulty };
    } catch {
        return null;
    }
}

/** 从首页 HTML 提取搜索表单的 sc token */
export function extractStartpageScToken(html: string): string | undefined {
    const match = html.match(/name="sc"[^>]*value="([^"]+)"/)
        || html.match(/value="([^"]+)"[^>]*name="sc"/);
    return match?.[1]?.trim() || undefined;
}

function collectSetCookies(response: { headers?: Record<string, unknown> }): string[] {
    const raw = response.headers?.['set-cookie'];
    const values = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
    return values.map((value) => String(value).split(';')[0]).filter(Boolean);
}

function mergeCookiePairs(...groups: string[][]): string {
    const jar = new Map<string, string>();
    for (const group of groups) {
        for (const pair of group) {
            const name = pair.split('=', 1)[0];
            if (name) {
                jar.set(name, pair);
            }
        }
    }
    return [...jar.values()].join('; ');
}

/**
 * 纯 HTTP 走通 Anubis 挑战，返回放行 cookie 与 sc token。
 * 协议不符/站点封禁（拿到 "Startpage Blocked"）时返回 null，由调用方回退 Playwright。
 */
export async function warmupWithAnubisPow(): Promise<AnubisSession | null> {
    const startedAt = Date.now();
    const requestOptions = (forceDirect: boolean) => buildAxiosRequestOptions({
        engine: 'startpage',
        // 不用 trustedStaticHost：它强制禁用重定向，而 Anubis 流程本身依赖 302
        // （首页可能重定向、pass-challenge 的放行凭证就在 302 响应上）
        forceDirect,
        headers: {
            'User-Agent': BROWSER_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 15000,
        validateStatus: (status: number) => status >= 200 && status < 400
    });

    // 1) 首页 → 挑战 payload + cookie
    const home = await requestDirectFirst('GET', `${STARTPAGE_BASE_URL}/`, requestOptions, 'Startpage Anubis');
    const homeHtml = String(home.data || '');
    const initialCookies = collectSetCookies(home);

    // 已被放行（无挑战）时直接提取 sc
    const directSc = extractStartpageScToken(homeHtml);
    if (directSc) {
        return { cookies: initialCookies.join('; '), scCode: directSc };
    }

    const challenge = parseAnubisChallenge(homeHtml);
    if (!challenge) {
        // "Startpage Blocked" 等硬封禁页没有挑战 payload —— 交给 Playwright 兜底或上层报错
        return null;
    }

    // 2) 本地 PoW
    const solved = solveAnubisPow(challenge.randomData, challenge.difficulty);
    if (!solved) {
        console.warn(`Startpage Anubis PoW exceeded ${POW_MAX_NONCE} iterations (difficulty ${challenge.difficulty})`);
        return null;
    }

    // 3) 提交解答 → 302 + spchal-auth
    const passUrl = `${STARTPAGE_BASE_URL}${ANUBIS_PASS_PATH}`
        + `?id=${encodeURIComponent(challenge.id)}`
        + `&response=${solved.hash}`
        + `&nonce=${solved.nonce}`
        + `&redir=${encodeURIComponent(`${STARTPAGE_BASE_URL}/`)}`
        + `&elapsedTime=${Date.now() - startedAt}`;
    const pass = await requestDirectFirst('GET', passUrl, (forceDirect) => ({
        ...requestOptions(forceDirect),
        // 302 响应上带 spchal-auth（跟随会丢失）——在此中断以读取 Set-Cookie
        stopOnRedirect: true,
        headers: {
            ...requestOptions(forceDirect).headers,
            'Cookie': initialCookies.join('; ')
        }
    }), 'Startpage Anubis pass');
    const authCookies = collectSetCookies(pass);
    if (pass.status !== 302 && pass.status !== 200) {
        console.warn(`Startpage Anubis pass-challenge returned HTTP ${pass.status}`);
        return null;
    }

    // 4) 带全部 cookie 取首页 → sc token
    const allCookies = mergeCookiePairs(initialCookies, authCookies);
    const home2 = await requestDirectFirst('GET', `${STARTPAGE_BASE_URL}/`, (forceDirect) => ({
        ...requestOptions(forceDirect),
        headers: {
            ...requestOptions(forceDirect).headers,
            'Cookie': allCookies
        }
    }), 'Startpage Anubis home');
    const scCode = extractStartpageScToken(String(home2.data || ''));
    if (!scCode) {
        return null;
    }

    return { cookies: allCookies, scCode };
}
