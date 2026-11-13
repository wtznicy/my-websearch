/**
 * RFC / IETF 官方网络规范与协议标准文档检索器。
 *
 * 官方纯文本数据源:
 * GET https://www.rfc-editor.org/rfc/rfc{num}.txt
 *
 * 覆盖:
 * - 核心网络协议（RFC 9110 HTTP Semantics, RFC 8446 TLS 1.3, RFC 9000 QUIC 等）
 * - 格式规范（RFC 8259 JSON, RFC 4122 UUID, RFC 7519 JWT 等）
 * - 架构与安全规范（OAuth 2.0, WebSocket, CORS, DNS 等）
 */

import { requestDirectFirst, buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { logSafeError, logTool } from '../../tools/toolShared.js';

export interface RfcResult {
    source: 'rfc';
    libraryId: string;
    documentationUrl: string;
    content: string;
    summary?: string;
    confidence?: 'high' | 'medium' | 'low';
    warnings?: string[];
}

export function isLikelyRfcTarget(target: string): boolean {
    const clean = target.trim().toLowerCase();
    return /^rfc:?\s*\d+/i.test(clean) || /^rfc\d+\b/i.test(clean);
}

export interface ParsedRfcSpecifier {
    rfcNumber: number;
    section?: string;
}

export function parseRfcSpecifier(target: string, query?: string): ParsedRfcSpecifier | null {
    const cleanTarget = target.trim();
    const match = cleanTarget.match(/^rfc:?\s*(\d+)(?:[#/:](.*))?$/i) || cleanTarget.match(/^rfc(\d+)(?:[#/:](.*))?$/i);
    if (!match || !match[1]) {
        return null;
    }

    const rfcNumber = parseInt(match[1], 10);
    if (!Number.isFinite(rfcNumber) || rfcNumber <= 0) {
        return null;
    }

    let section = match[2]?.trim();
    if (!section && query && query.trim()) {
        const cleanQuery = query.trim();
        const secMatch = cleanQuery.match(/(?:section|sec|§)\s*([0-9]+(?:\.[0-9]+)*)/i);
        if (secMatch && secMatch[1]) {
            section = secMatch[1];
        } else {
            section = cleanQuery;
        }
    }

    return {
        rfcNumber,
        ...(section ? { section } : {})
    };
}

/**
 * 清洗 RFC 纯文本：
 * 1. 统一换行符；
 * 2. 剥离分页符（\f）以及分页页眉/页脚；
 * 3. 适度合并段落内的 72 字符硬换行（保留缩进代码块、列表项与 ASCII 图表）。
 */
export function cleanRfcText(raw: string): string {
    let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 剥离 RFC 典型的分页页脚与后续页眉：
    // e.g. [Page 12]\n\f\nRFC 9110 ...
    text = text.replace(/\n[^\n]*\[Page \d+\]\s*\n\f\s*(?:RFC \d+[^\n]*\n)?(?:[^\n]*\d{4}\s*\n)?/gi, '\n');
    // 单独的 \f 兜底清除
    text = text.replace(/\f/g, '\n');

    // 适度段落解包（unwrap prose lines，但保留以 2+ 空格缩进的文本、代码、表格或列表）
    const lines = text.split('\n');
    const processed: string[] = [];
    let proseBuffer = '';

    const flushProse = () => {
        if (proseBuffer) {
            processed.push(proseBuffer.trim());
            proseBuffer = '';
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const trimmed = line.trim();

        if (!trimmed) {
            flushProse();
            processed.push('');
            continue;
        }

        // 深度缩进（6+空格）为代码块、ASCII 协议框图或列表项
        const isDeepIndented = /^ {6,}/.test(line);
        const isListItem = /^(?:[-*•]|\d+\.|\([a-z0-9]\))\s+/.test(trimmed);
        const isHeading = /^[0-9]+(?:\.[0-9]+)*\.?\s+[A-Z]/.test(trimmed);
        const isAsciiArt = /[-+|]{4,}/.test(line);
        const isRfcHeader = /^(?:Internet Engineering Task Force|Request for Comments|Category:|ISSN:|STD:|Obsoletes:|Updates:)/i.test(trimmed);

        if (isDeepIndented || isListItem || isHeading || isAsciiArt || isRfcHeader) {
            flushProse();
            processed.push(line);
        } else {
            // 普通正文行（含 RFC 标准 3 格缩进正文）
            if (proseBuffer) {
                proseBuffer += ' ' + trimmed;
            } else {
                proseBuffer = trimmed;
            }
        }
    }
    flushProse();

    return processed.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 提取 RFC 中的指定章节
 */
export function extractRfcSection(cleanText: string, sectionQuery: string): { title: string; content: string } | null {
    const normSec = sectionQuery.toLowerCase().replace(/^(?:section|sec|§)\s*/i, '').trim();
    if (!normSec) return null;

    // 匹配章节编号（如 "5.3"、"5"）或章节标题（如 "caching"、"header fields"）
    const isNum = /^[0-9]+(?:\.[0-9]+)*$/.test(normSec);

    const lines = cleanText.split('\n');
    let startIndex = -1;
    let sectionTitle = '';
    let startHeadingLevel = 1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const trimmed = line.trim();
        const headingMatch = trimmed.match(/^([0-9]+(?:\.[0-9]+)*)\.?\s+([^\n]+)$/);
        if (!headingMatch || !headingMatch[1] || !headingMatch[2]) continue;

        const headingNum = headingMatch[1];
        const headingText = headingMatch[2].trim();

        let matched = false;
        if (isNum) {
            matched = headingNum === normSec || headingNum === `${normSec}.`;
        } else {
            matched = headingText.toLowerCase().includes(normSec) || headingNum === normSec;
        }

        if (matched) {
            startIndex = i;
            sectionTitle = `${headingNum} ${headingText}`;
            startHeadingLevel = headingNum.split('.').length;
            break;
        }
    }

    if (startIndex === -1) {
        return null;
    }
    const startLine = lines[startIndex];
    if (startLine === undefined) {
        return null;
    }

    // 收集直到遇到同级或更高级章节
    const collected: string[] = [startLine];
    for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const trimmed = line.trim();
        const nextHeading = trimmed.match(/^([0-9]+(?:\.[0-9]+)*)\.?\s+[A-Z]/);
        if (nextHeading && nextHeading[1]) {
            const nextLevel = nextHeading[1].split('.').length;
            if (nextLevel <= startHeadingLevel) {
                break;
            }
        }
        collected.push(line);
    }

    return {
        title: sectionTitle,
        content: collected.join('\n').trim()
    };
}

/**
 * 提取 RFC 的摘要与目录概览（当未指定具体章节时，防止全文过载）
 */
export function extractRfcOverview(cleanText: string, maxChars = 20000): string {
    if (cleanText.length <= maxChars) {
        return cleanText;
    }

    // 查找 Abstract
    const abstractMatch = cleanText.match(/(?:^|\n)(Abstract\s*\n\n[\s\S]*?)(?=\n\n(?:Table of Contents|Status of This Memo|[0-9]+\.\s+))/i);
    const abstractText = abstractMatch && abstractMatch[1] ? abstractMatch[1].trim() : '';

    // 查找 Table of Contents
    const tocMatch = cleanText.match(/(?:^|\n)(Table of Contents\s*\n\n[\s\S]*?)(?=\n\n[0-9]+\.\s+[A-Z])/i);
    const tocText = tocMatch && tocMatch[1] ? tocMatch[1].trim() : '';

    // 提取正文前 2 节
    const sectionsMatch = cleanText.match(/(?:^|\n)([0-9]+\.\s+Introduction[\s\S]*?)(?=\n\n[3-9]\.\s+[A-Z]|\n\n1[0-9]\.\s+[A-Z]|$)/i);
    const introText = sectionsMatch && sectionsMatch[1] ? sectionsMatch[1].slice(0, 5000).trim() : '';

    const parts: string[] = [];
    // 包含元数据头部
    const headerLines = cleanText.split('\n').slice(0, 25).join('\n');
    parts.push(headerLines.trim());

    if (abstractText) {
        parts.push(`## ${abstractText}`);
    }
    if (tocText) {
        parts.push(`## ${tocText}`);
    }
    if (introText) {
        parts.push(`## Initial Sections\n\n${introText}`);
    }

    parts.push(`\n> [!NOTE]\n> This is an overview of the RFC. To view a specific section, query with \`query="section <num>"\` or \`library="rfc:<num>#section-<num>"\`.`);

    return parts.join('\n\n');
}

/**
 * 核心检索与拉取入口
 */
export async function queryRfcDocs(options: {
    library: string;
    query?: string;
    signal?: AbortSignal;
}): Promise<RfcResult | null> {
    const spec = parseRfcSpecifier(options.library, options.query);
    if (!spec) {
        return null;
    }

    const { rfcNumber, section } = spec;
    const rfcId = `RFC ${rfcNumber}`;
    const docUrl = `https://www.rfc-editor.org/rfc/rfc${rfcNumber}.txt`;

    logTool(`Querying RFC ${rfcNumber} from ${docUrl}`);

    try {
        const res = await requestDirectFirst(
            'GET',
            docUrl,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 8000,
                responseType: 'text',
                signal: options.signal,
                forceDirect
            }),
            `Fetching ${rfcId}`
        );

        if (res.status !== 200 || !res.data || typeof res.data !== 'string') {
            return null;
        }

        const cleaned = cleanRfcText(res.data);

        let finalContent: string;
        let summary: string | undefined;

        if (section) {
            const extracted = extractRfcSection(cleaned, section);
            if (extracted) {
                finalContent = `# ${rfcId} - ${extracted.title}\n\nURL: ${docUrl}\n\n${extracted.content}`;
                summary = `${rfcId} Section ${extracted.title}`;
            } else {
                // 小节未命中，回退到概览并警告
                finalContent = `# ${rfcId}\n\nURL: ${docUrl}\n\n` + extractRfcOverview(cleaned);
                summary = `${rfcId} (section "${section}" not found, showing overview)`;
            }
        } else {
            finalContent = `# ${rfcId}\n\nURL: ${docUrl}\n\n` + extractRfcOverview(cleaned);
            summary = `${rfcId} Overview & Table of Contents`;
        }

        return {
            source: 'rfc',
            libraryId: `rfc:${rfcNumber}`,
            documentationUrl: docUrl,
            content: finalContent,
            summary,
            confidence: 'high'
        };
    } catch (error) {
        logSafeError(`RFC fetch failed for RFC ${rfcNumber}`, error);
        return null;
    }
}
