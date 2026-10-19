import * as cheerio from 'cheerio';
import { assertPublicHttpUrl } from '../../utils/urlSafety.js';
import {
    ExtractedLink,
    HtmlExtractionResult,
    JsdomUnavailableError,
    ReadabilityArticle,
    ReadabilityUnavailableError
} from './types.js';

// jsdom 是 optionalDependencies（仅 readability/链接提取使用）：
// 延迟加载，缺失时相关功能报明确错误，不拖垮整个模块加载。
let jsdomModulePromise: Promise<typeof import('jsdom')> | null = null;
export function loadJsdom(): Promise<typeof import('jsdom')> {
    if (!jsdomModulePromise) {
        jsdomModulePromise = import('jsdom').catch((error) => {
            if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
                throw new JsdomUnavailableError('jsdom is not available (optional dependency not installed); readability/link extraction is disabled');
            }
            throw error;
        });
    }
    return jsdomModulePromise;
}

export const CHROME_NOISE_SELECTOR = [
    'nav',
    'header',
    'footer',
    'aside',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '.sidebar',
    '.navbar',
    '.breadcrumb',
    '.pagination',
    '.page-footer',
    '.article-footer',
    '.doc-footer',
    '.edit-on-github',
    '.bc-github-link',
    '#footer',
    'aside.metadata'
].join(', ');

export const MIN_METADATA_FALLBACK_CHARS = 200;

export function normalizeText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function looksLikeHtml(raw: string): boolean {
    return /<!doctype html|<html[\s>]|<body[\s>]/i.test(raw);
}

export function isMarkdownPath(url: URL): boolean {
    const pathname = url.pathname.toLowerCase();
    return pathname.endsWith('.md') || pathname.endsWith('.markdown') || pathname.endsWith('.mdx');
}

export function isMarkdownContentType(contentType: string): boolean {
    const ct = contentType.toLowerCase();
    return ct.includes('text/markdown') || ct.includes('application/markdown') || ct.includes('text/x-markdown');
}

function shouldDebugReadabilityFallback(): boolean {
    return (process.env.LOG_LEVEL ?? '').toLowerCase() === 'debug';
}

export function logReadabilityFallback(message: string, error?: unknown): void {
    if (!shouldDebugReadabilityFallback()) {
        return;
    }

    if (error instanceof Error) {
        console.error(`[fetchWebContent/readability] ${message}: ${error.message}`);
        return;
    }

    console.error(`[fetchWebContent/readability] ${message}`);
}

/**
 * 探测站点在页面顶部或 `<link rel="alternate" type="text/markdown">` 中声明的 LLM 专用 Markdown 地址
 * （如 Vue.js 文档页顶部的 "Are you an LLM? You can read better optimized documentation at /guide/.../computed.md"）。
 * 仅允许同源且路径为 `.md` / `.markdown` / `.mdx` 的地址，防止跳转到外部任意 URL。
 */
export function detectLlmMarkdownUrl(rawHtml: string, extractedText: string, baseUrl: string): string | null {
    let baseParsed: URL;
    try {
        baseParsed = new URL(baseUrl);
    } catch {
        return null;
    }

    const resolveSameOriginMd = (candidate: string): string | null => {
        const cleaned = candidate.trim().replace(/[).,;:'"]+$/, '');
        if (!cleaned) {
            return null;
        }
        try {
            const resolved = new URL(cleaned, baseParsed);
            if (resolved.origin !== baseParsed.origin) {
                return null;
            }
            if (!isMarkdownPath(resolved)) {
                return null;
            }
            if (resolved.toString() === baseParsed.toString()) {
                return null;
            }
            return resolved.toString();
        } catch {
            return null;
        }
    };

    const headSnippet = rawHtml.slice(0, 6000);
    const linkMatch = headSnippet.match(/<link\b[^>]*rel=["']alternate["'][^>]*type=["']text\/(?:x-)?markdown["'][^>]*>/i)
        || headSnippet.match(/<link\b[^>]*type=["']text\/(?:x-)?markdown["'][^>]*rel=["']alternate["'][^>]*>/i);
    if (linkMatch) {
        const hrefMatch = linkMatch[0].match(/\bhref=["']([^"']+)["']/i);
        if (hrefMatch?.[1]) {
            const resolved = resolveSameOriginMd(hrefMatch[1]);
            if (resolved) {
                return resolved;
            }
        }
    }

    const leadingText = `${extractedText.slice(0, 800)}\n${headSnippet}`;
    const llmPromptPatterns = [
        /Are you an LLM\?[\s\S]{0,240}?(https?:\/\/[^\s"'<>)+,]+\.(?:md|markdown|mdx)|\/[A-Za-z0-9._/-]+\.(?:md|markdown|mdx))\b/i,
        /(?:for\s+LLMs?|LLM-friendly|AI\s+agent|language\s+model)[^\n.]{0,180}?(https?:\/\/[^\s"'<>)+,]+\.(?:md|markdown|mdx)|\/[A-Za-z0-9._/-]+\.(?:md|markdown|mdx))\b/i
    ];
    for (const pattern of llmPromptPatterns) {
        const match = leadingText.match(pattern);
        if (match?.[1]) {
            const resolved = resolveSameOriginMd(match[1]);
            if (resolved) {
                return resolved;
            }
        }
    }

    return null;
}

/**
 * 在克隆节点上剥离导航栏/侧边栏/页脚等非正文区块。
 * 若剥离后剩余正文长度仍达标（>= minChars），则采用净化后的节点；
 * 否则保留原节点（防止短页面或把正文写在 header 里的非常规页面被误清空）。
 *
 * 剥离时**保留噪声节点内的 h1/h2 标题**：`<article><header><h1>标题</h1></header>` 是
 * 博客/资讯站的常见结构（实测 blog.vuejs.org/posts/vue-3-5：整篇正文的 H1 在 <header> 里，
 * 直接 remove 会让提取结果丢掉文章标题——旧逻辑 6905 字符含标题，剥离后 6584 字符标题消失）。
 * 只救 h1/h2：它们承载标题语义；nav/侧边栏里的 h3~h6 多为栏目标签，属噪声。
 */
export function stripChromeNoiseWithGuard(
    $: cheerio.CheerioAPI,
    element: ReturnType<cheerio.CheerioAPI>,
    minChars: number
): { text: string; html: string } {
    const rawText = normalizeText(element.text());
    const rawHtml = element.html() || '';
    const cloned = element.clone();
    cloned.find(CHROME_NOISE_SELECTOR).each((_, node) => {
        const noise = $(node);
        const headings = noise.find('h1, h2');
        if (headings.length > 0) {
            noise.before(headings.clone());
        }
        noise.remove();
    });
    const cleanedText = normalizeText(cloned.text());
    if (cleanedText.length >= minChars || (rawText.length < minChars && cleanedText.length > 0)) {
        return { text: cleanedText, html: cloned.html() || rawHtml };
    }
    return { text: rawText, html: rawHtml };
}

export function extractMainTextFromHtml(html: string): HtmlExtractionResult {
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() ||
        $('meta[property="og:description"]').attr('content')?.trim() ||
        '';

    $('script, style, noscript, template, iframe, svg, canvas').remove();

    const preferredContainers = [
        'article',
        'main',
        '[role="main"]',
        '.markdown-body',
        '.article-content',
        '.post-content',
        '.entry-content',
        '.content'
    ];

    let selectedText = '';
    let selectedHtml: string | undefined;
    let mode: HtmlExtractionResult['mode'] = 'metadata';
    for (const selector of preferredContainers) {
        const container = $(selector).first();
        if (container.length === 0) {
            continue;
        }

        const { text: candidate, html: candidateHtml } = stripChromeNoiseWithGuard($, container, 120);
        if (candidate.length >= 120) {
            selectedText = candidate;
            selectedHtml = candidateHtml;
            mode = 'container';
            break;
        }
    }

    if (!selectedText) {
        const body = $('body');
        const target = body.length > 0 ? body : ($.root() as unknown as ReturnType<cheerio.CheerioAPI>);
        const { text: bodyText, html: bodyHtml } = stripChromeNoiseWithGuard($, target, 120);
        if (bodyText) {
            selectedText = bodyText;
            selectedHtml = bodyHtml;
            mode = 'body';
        }
    }

    // SPA pages often render content by JS and leave body nearly empty.
    // Fall back to metadata so callers still get useful page info.
    if (!selectedText) {
        selectedText = normalizeText([title, metaDescription].filter(Boolean).join('\n\n'));
        mode = 'metadata';
    }

    return { title, text: selectedText, html: selectedHtml, mode };
}

export async function extractReadableTextFromHtml(html: string): Promise<string> {
    const { JSDOM } = await loadJsdom();
    const dom = new JSDOM(html);
    return normalizeText(dom.window.document.body.textContent || '');
}

export async function extractReadableLinks(html: string, finalUrl: string): Promise<ExtractedLink[]> {
    const { JSDOM } = await loadJsdom();
    const dom = new JSDOM(html, { url: finalUrl });
    const anchors = Array.from(dom.window.document.querySelectorAll('a[href]'));
    const seen = new Set<string>();
    const links: ExtractedLink[] = [];

    for (const anchor of anchors) {
        const rawHref = anchor.getAttribute('href');
        if (!rawHref) {
            continue;
        }

        let href: string;
        try {
            href = new URL(rawHref, finalUrl).toString();
            assertPublicHttpUrl(href, 'Extracted link URL');
        } catch {
            continue;
        }

        if (seen.has(href)) {
            continue;
        }
        seen.add(href);

        links.push({
            text: normalizeText(anchor.textContent || ''),
            href
        });
    }

    return links;
}

let readabilityParser: (html: string, finalUrl: string) => Promise<ReadabilityArticle | null> = async (html, finalUrl) => {
    try {
        const moduleName = '@mozilla/readability';
        const readabilityModule = await import(moduleName);
        const { JSDOM } = await loadJsdom();
        const dom = new JSDOM(html, { url: finalUrl });
        // keepClasses：Readability 默认会剥掉所有 class，而代码块语言只存在于
        // `<code class="language-x">` / 外层 `language-x` 容器上——剥掉后下游 Markdown 转换
        // 拿不到语言（实测 readability:true 时 7 个围栏 0 带语言 + 语言标签漏成正文；不传 readability 时 7/7 带语言）
        return new readabilityModule.Readability(dom.window.document, { keepClasses: true }).parse();
    } catch (error) {
        if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
            throw new ReadabilityUnavailableError('Mozilla Readability is not available. Install `@mozilla/readability` to use readability mode.');
        }
        throw error;
    }
};

export async function parseReadabilityArticle(html: string, finalUrl: string): Promise<ReadabilityArticle | null> {
    return readabilityParser(html, finalUrl);
}

export function __setReadabilityParserForTests(parser?: (html: string, finalUrl: string) => Promise<ReadabilityArticle | null>): void {
    readabilityParser = parser || (async (html, finalUrl) => {
        try {
            const moduleName = '@mozilla/readability';
            const readabilityModule = await import(moduleName);
            const { JSDOM } = await loadJsdom();
            const dom = new JSDOM(html, { url: finalUrl });
            return new readabilityModule.Readability(dom.window.document, { keepClasses: true }).parse();
        } catch (error) {
            if (error instanceof Error && /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
                throw new ReadabilityUnavailableError('Mozilla Readability is not available. Install `@mozilla/readability` to use readability mode.');
            }
            throw error;
        }
    });
}
