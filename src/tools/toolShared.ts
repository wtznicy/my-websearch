import axios from 'axios';
import { FetchWebContentResult } from '../engines/web/fetchWebContent.js';
import { extractErrorStatus } from '../core/errors.js';

export { extractErrorStatus };

/**
 * MCP 单次响应硬上限（字节）。防止 fetchWebContent 在 raw/大 maxChars 场景下
 * 把数 MB JSON 塞进 MCP response 浪费客户端 token。默认 60KB，可配置。
 */
export function getResponseCapBytes(): number {
    const raw = Number(process.env.OPEN_WEBSEARCH_RESPONSE_CAP_BYTES ?? 60000);
    return Number.isFinite(raw) && raw > 0 ? raw : 60000;
}
export const RESPONSE_CAP_BYTES = 60000;

export const TOOL_ANNOTATION_HINTS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
} as const;

/** 给 MCP 错误文本追加一行 Hint，帮助 LLM/用户决定下一步 */
export function withErrorHint(message: string, hint: string): string {
    return `${message}\nHint: ${hint}`;
}

// context7 匿名配额（200 次/月，按出口 IP 计）用尽后，重试不会自愈——
// 用专门 Hint 替代"稍后重试"，避免 LLM 反复重试。
export const CONTEXT7_QUOTA_HINT =
    'Context7 匿名配额已用尽（200 次/月，按出口 IP 计，TUN 下即代理节点 IP）；'
    + '设置 CONTEXT7_API_KEY 可立即恢复（免费申请 https://context7.com/dashboard），否则需等配额重置。';

/**
 * fetchWebContent 错误提示按错误类型区分，避免把"页面不存在（404）"也提示成
 * "降低 maxChars 继续分页读取"这类无关建议。依据错误消息/状态码归类：
 * 404 → URL 问题；4xx → 被拒/反爬；5xx → 上游故障；网络类 → 网络/代理；提取失败 → raw/maxChars。
 */
export function buildFetchWebErrorHint(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const status = extractErrorStatus(error);

    // 安全拦截放在最前：私网拦截的文案里含 "network" 一词，若先走网络分支会把
    // "已被安全策略拒绝"提示成"开启代理重试"——等于引导调用方绕过防护（测评报告 P1-6）
    if (/private or local network|wildcard DNS|rebinding|blackhole|0\.0\.0\.0\/8/i.test(message)) {
        return '该地址指向内网/本地，或使用了可指向内网的不可信域名，已被安全策略拒绝——这是预期行为，请改用公开可访问的 URL。';
    }

    if (/反爬验证|ERR_BOT_CHALLENGE|bot challenge|荒原/i.test(message)) {
        return '目标站点触发反爬验证或需要登录——可稍后重试、在浏览器中登录后重试，或改换其他信息来源。';
    }

    if (typeof status === 'number') {
        if (status === 404) {
            return '目标页面不存在（404）——检查 URL 是否正确、页面是否已删除、或站点需要登录后才能访问。';
        }
        if (status >= 500) {
            return `目标站点返回服务器错误（HTTP ${status}）——上游问题，可稍后重试或换一个来源页面。`;
        }
        if (status >= 400) {
            return `目标站点拒绝了请求（HTTP ${status}）——页面可能要求登录/验证，或站点对自动化抓取有反爬限制。`;
        }
    }

    if (/could not be resolved|ENOTFOUND|EAI_AGAIN/i.test(message)) {
        return '域名解析失败——检查域名拼写；若本机 DNS 解析不了该站点，可配置代理（PROXY_URL，如 http://127.0.0.1:7897）后重试。';
    }

    if (/timeout|timed out|ECONN|ETIMEDOUT|socket hang up|network|ENETUNREACH/i.test(message)) {
        return '网络错误——可稍后重试；若目标站点需代理访问，配置 PROXY_URL（如 http://127.0.0.1:7897）后重试。';
    }

    const startOutMatch = message.match(/startIndex\s+(\d+)\s+is beyond content length\s+(\d+)/i);
    if (startOutMatch || /ERR_START_INDEX_OUT_OF_RANGE|start_index_out_of_range/i.test(message)) {
        const startIdx = startOutMatch?.[1] ?? '?';
        const totalLen = startOutMatch?.[2] ?? '?';
        return `startIndex (${startIdx}) 超出正文实际总长度（totalLength=${totalLen}）——无需降低 maxChars，请将 startIndex 设为小于 ${totalLen} 的偏移量，或重置为 0 从头读取。`;
    }

    if (/application\/pdf|PDF binary files|\.pdf\b/i.test(message)) {
        return '目标地址为 PDF 二进制文件——fetchWebContent 不支持直接解析 PDF（且降低 maxChars 不会改变 2MB 下载体积上限），请改用对应的 HTML/Markdown 文档地址。';
    }

    if (/Response body too large|ERR_RESPONSE_TOO_LARGE|response_too_large|maxContentLength|maxBodyLength/i.test(message)) {
        return '目标响应体超过 2MB 下载硬上限（MAX_DOWNLOAD_BYTES）——降低 maxChars 仅控制提取后的返回字符数，无法绕过 HTTP 下载体积上限；请改抓更具体的子页面或章节地址。';
    }

    if (/no readable content|extraction failed/i.test(message)) {
        return '页面正文提取失败——可尝试 raw=true 获取原始内容，或降低 maxChars。';
    }

    return '可降低 maxChars，或用 startIndex 分页继续读取长文档。';
}

/**
 * 工具级日志门控：LOG_LEVEL=quiet（或 OPEN_WEBSEARCH_QUIET_STARTUP=true）时
 * 静默所有工具执行日志（搜索词、URL、库名等），避免噪音与隐私信息写入宿主日志。
 */
export function isQuietToolLogs(): boolean {
    return (process.env.LOG_LEVEL ?? '').toLowerCase() === 'quiet'
        || process.env.OPEN_WEBSEARCH_QUIET_STARTUP === 'true';
}

export function logTool(message: string): void {
    if (!isQuietToolLogs()) {
        console.error(message);
    }
}

/**
 * 只输出安全的错误摘要（message + HTTP status + code），
 * 不要把整个 AxiosError 打进日志——其 config.headers 里含
 * CONTEXT7_API_KEY 的 Authorization 头和浏览器 Cookie，会泄露凭据。
 */
export function logSafeError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const details: string[] = [];
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const code = axios.isAxiosError(error) ? error.code : (error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : undefined);
    if (status !== undefined) {
        details.push(`HTTP ${status}`);
    }
    if (code) {
        details.push(code);
    }
    logTool(`${context}: ${message}${details.length > 0 ? ` (${details.join(', ')})` : ''}`);
}

/**
 * 纯文本响应封顶：超出 RESPONSE_CAP_BYTES（字节）时截断并标注，
 * 防止超长文章/README 把数 MB 文本塞进 MCP response。
 * 按 UTF-8 字节计量（中文 1 字 = 3 字节），并避免切断多字节字符。
 */
export function capTextResponse(text: string): string {
    const cap = getResponseCapBytes();
    if (Buffer.byteLength(text, 'utf8') <= cap) {
        return text;
    }
    let truncated = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8');
    // 截断点可能落在多字节字符中间，去掉因此产生的替换符（U+FFFD）
    while (truncated.endsWith('\uFFFD')) {
        truncated = truncated.slice(0, -1);
    }
    return `${truncated}\n[truncated by response cap (${cap} bytes); article too long to return in full]`;
}

/**
 * 序列化 fetchWebContent 结果，超出硬上限时分两级收敛：
 * 1) 丢弃低价值中间字段（readableHtml / raw）；
 * 2) 截断 content 并保留分页指针（startIndex/nextStartIndex/hasMore），
 *    调用方可用 startIndex 继续读完整个文档。
 */
export function serializeFetchWebResult(result: FetchWebContentResult): string {
    const cap = getResponseCapBytes();
    const full = JSON.stringify(result, null, 2);
    if (Buffer.byteLength(full, 'utf8') <= cap) {
        return full;
    }

    const { readableHtml, raw, ...core } = result as unknown as Record<string, unknown> & { content?: string; startIndex?: number; totalLength?: number };
    const trimmed = JSON.stringify(core, null, 2);
    if (Buffer.byteLength(trimmed, 'utf8') <= cap) {
        return trimmed;
    }

    const content = core.content ?? '';
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const trimmedBytes = Buffer.byteLength(trimmed, 'utf8');
    const overhead = Math.max(0, trimmedBytes - contentBytes);
    const room = Math.max(0, cap - overhead - 256);

    let cutStr = '';
    if (room > 0) {
        const cutBuf = Buffer.from(content, 'utf8').subarray(0, room);
        cutStr = cutBuf.toString('utf8');
        while (cutStr.endsWith('\uFFFD')) {
            cutStr = cutStr.slice(0, -1);
        }
    }
    const cut = cutStr.length;
    const startIndex = core.startIndex ?? 0;
    return JSON.stringify({
        ...core,
        content: `${cutStr}\n[truncated by response cap; use startIndex=${startIndex + cut} to continue]`,
        truncated: true,
        hasMore: true,
        nextStartIndex: startIndex + cut,
        totalLength: core.totalLength ?? content.length
    }, null, 2);
}

// 获取工具名称，优先使用环境变量，否则使用默认值
export function getToolName(envVarName: string, defaultName: string): string {
    const configuredName = process.env[envVarName];
    if (configuredName) {
        // Validate tool name to ensure it follows MCP naming conventions
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(configuredName)) {
            console.warn(`Invalid tool name "${configuredName}" from environment variable ${envVarName}. Using default: "${defaultName}"`);
            return defaultName;
        }
        logTool(`Using custom tool name "${configuredName}" for ${envVarName}`);
        return configuredName;
    }
    return defaultName;
}
