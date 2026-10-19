import { SearchResult } from '../../types.js';
import { AppError, isAppError } from '../../core/errors.js';
import { requestDirectFirst, buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { impersonateHttpGet } from '../../utils/impersonateRequest.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';

interface GrepAppHit {
    // grep.app 线上响应是扁平字符串（repo/path/branch），旧版 mock/文档里是 { raw } 包装；
    // 两种形状都兼容，避免上游改 schema 后解析出 "unknown: "。
    repo?: { raw?: string } | string;
    path?: { raw?: string } | string;
    branch?: { raw?: string } | string;
    content?: { snippet?: string };
    line?: { raw?: number } | number;
}

interface GrepAppResponse {
    hits?: {
        total?: number;
        hits?: GrepAppHit[];
    };
    facets?: unknown;
}

export async function searchGrepApp(
    query: string,
    limit = 10,
    context?: { signal?: AbortSignal }
): Promise<SearchResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
        return [];
    }

    const apiUrl = `https://grep.app/api/search?q=${encodeURIComponent(cleanQuery)}`;
    const headers: Record<string, string> = {
        'User-Agent': DEFAULT_DESKTOP_UA,
        'Accept': 'application/json, text/plain, */*',
        // grep.app 前置的 Vercel 风控对缺少 Accept-Language 的“非浏览器”请求直接回 429 challenge；
        // 补上该头后同一 IP 可正常返回 200（已实测：仅此一个头即可从 429 变 200）。
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://grep.app/'
    };

    const requestConfig = {
        headers,
        timeout: 8000,
        signal: context?.signal,
        responseType: 'json' as const,
        maxRedirects: 0,
        validateStatus: (status: number) => status >= 200 && status < 500
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any;
    try {
        // grep.app 前置 Vercel 风控会按 TLS/HTTP2 指纹拦截普通 Node 请求（同一 IP/Headers 下
        // curl 200、axios 429）。优先复用项目已有的 wreq-js Chrome 指纹会话；
        // wreq 不可用或网络层失败时，回退到带 SSRF 校验的直连/代理请求。
        try {
            response = await impersonateHttpGet('code', apiUrl, requestConfig, {
                redirect: 'manual',
                failOnHttpError: false
            });
        } catch (impersonateError) {
            if (context?.signal?.aborted) {
                throw impersonateError;
            }
            // HTTP 状态错误（如 429 challenge）直接交给外层分类，不能当成网络失败去重试/回退
            const impersonateStatus = (impersonateError as { response?: { status?: number } })?.response?.status
                ?? (impersonateError as { status?: number })?.status;
            if (typeof impersonateStatus === 'number') {
                throw impersonateError;
            }
            response = await requestDirectFirst('GET', apiUrl, (forceDirect) => ({
                ...buildAxiosRequestOptions({
                    engine: 'code',
                    headers,
                    forceDirect,
                    signal: context?.signal,
                    timeout: 8000
                }),
                maxRedirects: 0,
                stopOnRedirect: true,
                responseType: 'json',
                validateStatus: (status: number) => status >= 200 && status < 500
            }), 'grep.app code search');
        }
    } catch (err) {
        if (context?.signal?.aborted) {
            throw err;
        }
        if (isAppError(err)) {
            throw err;
        }
        const errResponse = (err as { response?: { status?: number; headers?: Record<string, string> } })?.response;
        const errStatus = errResponse?.status;
        const location = String(errResponse?.headers?.location || errResponse?.headers?.Location || '');
        const errMessage = err instanceof Error ? err.message : String(err);
        // Vercel 的 429 可能是“限流”，也可能是“人机挑战”（x-vercel-mitigated: challenge）。
        // 后者属于反爬终态：不可重试，否则 LLM 会反复打上游。
        const mitigated = String(
            errResponse?.headers?.['x-vercel-mitigated']
            ?? errResponse?.headers?.['X-Vercel-Mitigated']
            ?? ''
        ).toLowerCase();
        const challengeSignal = mitigated.includes('challenge')
            || /google\.com\/sorry|sorry|checkpoint|captcha|unusual traffic|security verification/i.test(`${location} ${errMessage}`);

        if (errStatus === 429) {
            throw new AppError({
                code: challengeSignal ? 'bot_challenge' : 'rate_limited',
                engine: 'code',
                retryable: !challengeSignal,
                hint: challengeSignal
                    ? 'grep.app 对本机出口 IP 触发了 Vercel 人机挑战；换用其他引擎，或切换网络/代理节点后再试。'
                    : 'grep.app 限流；稍后重试或换用其他引擎。',
                message: challengeSignal
                    ? `grep.app triggered Vercel security challenge (HTTP 429${mitigated ? `, x-vercel-mitigated: ${mitigated}` : ''})`
                    : 'grep.app code search rate limited (HTTP 429)'
            });
        }

        // 4xx/5xx 但命中挑战特征（如 403 + checkpoint）仍按 bot_challenge 处理，
        // 不能被通用 engine_error 分支抢先吞掉。
        if (typeof errStatus === 'number' && errStatus >= 400 && !challengeSignal) {
            throw new AppError({
                code: 'engine_error',
                engine: 'code',
                retryable: errStatus >= 500,
                message: `grep.app returned HTTP ${errStatus}`
            });
        }

        if (
            (typeof errStatus === 'number' && errStatus >= 300 && errStatus < 400) ||
            challengeSignal
        ) {
            throw new AppError({
                code: 'bot_challenge',
                engine: 'code',
                message: `grep.app triggered security checkpoint (${location || errMessage})`,
                retryable: false
            });
        }

        throw new AppError({
            code: 'network_error',
            engine: 'code',
            message: `grep.app request failed: ${errMessage}`,
            retryable: true
        });
    }

    const locationHeader = String(response.headers?.location || response.headers?.Location || '');
    if (
        (response.status >= 300 && response.status < 400) ||
        /google\.com\/sorry|sorry|checkpoint|captcha/i.test(locationHeader)
    ) {
        throw new AppError({
            code: 'bot_challenge',
            engine: 'code',
            message: `grep.app triggered security checkpoint (HTTP ${response.status} redirect${locationHeader ? ` to ${locationHeader}` : ''})`,
            retryable: false
        });
    }

    if (response.status === 429) {
        const mitigated = String(response.headers?.['x-vercel-mitigated'] ?? '').toLowerCase();
        const challenged = mitigated.includes('challenge')
            || /challenge|checkpoint|captcha|sorry/i.test(locationHeader);
        throw new AppError({
            code: challenged ? 'bot_challenge' : 'rate_limited',
            engine: 'code',
            retryable: !challenged,
            hint: challenged
                ? 'grep.app 对本机出口 IP 触发了 Vercel 人机挑战；换用其他引擎，或切换网络/代理节点后再试。'
                : 'grep.app 限流；稍后重试或换用其他引擎。',
            message: challenged
                ? 'grep.app triggered Vercel security challenge (HTTP 429)'
                : 'grep.app code search rate limited (HTTP 429)'
        });
    }

    if (response.status >= 400) {
        throw new AppError({
            code: 'engine_error',
            engine: 'code',
            message: `grep.app returned HTTP ${response.status}`,
            retryable: response.status >= 500
        });
    }

    // wreq 的响应体是字符串；axios 走 responseType:'json' 时是对象。统一在这里解析。
    let data: unknown = response.data;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            // 保留原始字符串，交给 parseGrepAppResponse 做 challenge 页面识别
        }
    }
    return parseGrepAppResponse(data, limit);
}

function decodeGrepAppEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * grep.app 的 snippet 是带行号的 HTML 表格（<tr data-line="199">...<pre>code</pre>）。
 * 转成 "199: code" 的纯文本，避免把整段 HTML 塞进 LLM 上下文。
 */
export function extractGrepAppSnippet(snippet: string): { text: string; firstLine?: number } {
    if (!/<table[\s>]/i.test(snippet)) {
        return { text: snippet.replace(/<\/?mark>/gi, '').trim() };
    }

    const rows = [...snippet.matchAll(/data-line="(\d+)"[\s\S]*?<pre>([\s\S]*?)<\/pre>/g)];
    const lines: Array<{ num: number; code: string }> = [];
    for (const row of rows) {
        const num = Number(row[1]);
        const code = decodeGrepAppEntities(row[2]!.replace(/<[^>]+>/g, '')).replace(/\s+$/g, '');
        if (Number.isFinite(num)) {
            lines.push({ num, code });
        }
    }

    if (lines.length === 0) {
        return { text: decodeGrepAppEntities(snippet.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() };
    }

    return {
        text: lines.map((line) => `${line.num}: ${line.code}`).join('\n').trim(),
        firstLine: lines[0]!.num
    };
}

export function parseGrepAppResponse(data: GrepAppResponse | string | unknown, limit = 10): SearchResult[] {
    if (typeof data === 'string') {
        if (
            data.includes('Security Checkpoint') ||
            data.includes('cf-browser-verification') ||
            data.includes('google.com/sorry') ||
            data.includes('sorry/index') ||
            data.includes('recaptcha') ||
            data.includes('Our systems have detected unusual traffic') ||
            /captcha|checkpoint/i.test(data)
        ) {
            throw new AppError({
                code: 'bot_challenge',
                engine: 'code',
                message: 'grep.app triggered security checkpoint',
                retryable: false
            });
        }
        return [];
    }

    const typedData = data as GrepAppResponse;
    const hits = typedData?.hits?.hits;
    if (!Array.isArray(hits) || hits.length === 0) {
        return [];
    }

    const results: SearchResult[] = [];
    for (const hit of hits.slice(0, limit)) {
        const repo = (typeof hit.repo === 'string' ? hit.repo : hit.repo?.raw) || 'unknown';
        const filePath = (typeof hit.path === 'string' ? hit.path : hit.path?.raw) || '';
        const branch = (typeof hit.branch === 'string' ? hit.branch : hit.branch?.raw) || 'master';
        const snippetRaw = hit.content?.snippet || '';
        const { text: snippetText, firstLine } = extractGrepAppSnippet(snippetRaw);
        const line = typeof hit.line === 'number'
            ? hit.line
            : (hit.line?.raw ?? firstLine);
        const lineAnchor = typeof line === 'number' ? `#L${line}` : '';
        const url = `https://github.com/${repo}/blob/${branch}/${filePath}${lineAnchor}`;
        const title = `${repo}: ${filePath}${lineAnchor}`;
        const description = snippetText.length > 400
            ? `${snippetText.slice(0, 400)}...`
            : snippetText;

        results.push({
            title,
            url,
            description: description || `Code match in ${repo} at ${filePath}`,
            source: repo,
            engine: 'code',
            repo,
            path: filePath,
            line
        });
    }

    return results;
}
