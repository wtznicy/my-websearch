import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { AppError } from '../../core/errors.js';
import { htmlToMarkdown } from '../../utils/markdown.js';

/**
 * 无 LLM 的结构化提取：给定 CSS 选择器 schema，把页面 DOM 直接转成 JSON。
 *
 * 形状参考 crawl4ai 的 JsonCssExtractionStrategy（baseSelector + fields），
 * 因为它是目前「不需要模型也能拿结构化数据」的成熟约定：
 *
 * ```json
 * {
 *   "baseSelector": "div.quote",
 *   "fields": [
 *     { "name": "text",   "selector": "span.text",  "type": "text" },
 *     { "name": "author", "selector": "small.author", "type": "text" },
 *     { "name": "href",   "selector": "@href", "type": "attribute", "attribute": "href" }
 *   ]
 * }
 * ```
 *
 * 安全边界：selector 只交给 cheerio 解析（无 eval），但仍限制字段数、节点数与嵌套深度，
 * 避免构造一个把单次抓取拖死的 schema。
 */

export const MAX_EXTRACT_FIELDS = 50;
export const MAX_EXTRACT_NODES = 500;
export const MAX_EXTRACT_DEPTH = 3;

export type ExtractFieldType = 'text' | 'html' | 'markdown' | 'attribute' | 'list';

export type ExtractField = {
    name: string;
    selector?: string;
    type?: ExtractFieldType;
    attribute?: string;
    fields?: ExtractField[];
    /** text/html/markdown 字段：返回所有匹配节点的数组而不是第一个 */
    all?: boolean;
};

export type ExtractSchema = {
    baseSelector?: string;
    fields: ExtractField[];
};

export type ExtractResult = {
    items: Array<Record<string, unknown>>;
    count: number;
    /** baseSelector 命中的节点数（无 baseSelector 时为 1） */
    matchedBase: number;
};

const FIELD_TYPES: readonly ExtractFieldType[] = ['text', 'html', 'markdown', 'attribute', 'list'];

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const invalid = (message: string): AppError => new AppError({
    code: 'invalid_arguments',
    retryable: false,
    message
});

function validateField(raw: unknown, path: string, depth: number): ExtractField {
    if (!isPlainObject(raw)) {
        throw invalid(`extract.fields${path} must be an object`);
    }
    if (depth > MAX_EXTRACT_DEPTH) {
        throw invalid(`extract schema nesting is deeper than ${MAX_EXTRACT_DEPTH} levels`);
    }

    const name = raw.name;
    if (typeof name !== 'string' || !name.trim()) {
        throw invalid(`extract.fields${path}.name must be a non-empty string`);
    }

    const type = (raw.type ?? 'text') as ExtractFieldType;
    if (!FIELD_TYPES.includes(type)) {
        throw invalid(`extract.fields${path}.type must be one of: ${FIELD_TYPES.join(', ')}`);
    }

    const selector = raw.selector;
    if (selector !== undefined && typeof selector !== 'string') {
        throw invalid(`extract.fields${path}.selector must be a string`);
    }
    if ((type === 'attribute' || type === 'list') && !selector) {
        throw invalid(`extract.fields${path}.selector is required for type "${type}"`);
    }

    const attribute = raw.attribute;
    const isAttributeShorthand = typeof selector === 'string' && selector.startsWith('@');
    if (type === 'attribute' && !isAttributeShorthand && (typeof attribute !== 'string' || !attribute.trim())) {
        throw invalid(`extract.fields${path}.attribute is required for type "attribute" (or use selector "@attr")`);
    }

    if (type === 'list') {
        if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
            throw invalid(`extract.fields${path}.fields must be a non-empty array for type "list"`);
        }
        if (raw.fields.length > MAX_EXTRACT_FIELDS) {
            throw invalid(`extract.fields${path}.fields exceeds ${MAX_EXTRACT_FIELDS} entries`);
        }
        const nested = raw.fields.map((child, index) => validateField(child, `${path}.fields[${index}]`, depth + 1));
        return {
            name: name.trim(),
            selector,
            type,
            ...(typeof attribute === 'string' ? { attribute } : {}),
            fields: nested
        };
    }

    return {
        name: name.trim(),
        ...(selector ? { selector } : {}),
        type,
        ...(typeof attribute === 'string' ? { attribute } : {}),
        ...(raw.all === true ? { all: true } : {})
    };
}

/** 校验并规范化外部传入的 schema（来自 MCP 参数 / CLI JSON），失败抛 invalid_arguments。 */
export function validateExtractSchema(raw: unknown): ExtractSchema {
    if (!isPlainObject(raw)) {
        throw invalid('extract must be an object with a "fields" array');
    }
    if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
        throw invalid('extract.fields must be a non-empty array');
    }
    if (raw.fields.length > MAX_EXTRACT_FIELDS) {
        throw invalid(`extract.fields exceeds ${MAX_EXTRACT_FIELDS} entries`);
    }

    const baseSelector = raw.baseSelector;
    if (baseSelector !== undefined && (typeof baseSelector !== 'string' || !baseSelector.trim())) {
        throw invalid('extract.baseSelector must be a non-empty string when provided');
    }

    return {
        ...(typeof baseSelector === 'string' ? { baseSelector: baseSelector.trim() } : {}),
        fields: raw.fields.map((field, index) => validateField(field, `.fields[${index}]`, 1))
    };
}

type CheerioApi = cheerio.CheerioAPI;

const normalizeText = (value: string): string => value.replace(/[\t\r\f\v]+/g, ' ').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

const nodeToAttribute = ($: CheerioApi, node: AnyNode, attribute: string): string | undefined => {
    const value = $(node).attr(attribute);
    return value === undefined ? undefined : value;
};

/**
 * 解析单个字段。
 * selector 支持三种形式：
 *   - 省略 → 当前节点自身
 *   - `@attr` → 当前节点上的属性（可省 type/attribute）
 *   - CSS → 在当前节点下 find
 */
function resolveFieldValue(
    $: CheerioApi,
    node: AnyNode,
    field: ExtractField
): unknown {
    const selector = field.selector;

    if (selector && selector.startsWith('@')) {
        return nodeToAttribute($, node, selector.slice(1)) ?? null;
    }

    const nodes = selector ? $(node).find(selector).toArray() : [node];

    if (field.type === 'list') {
        const children = nodes.slice(0, MAX_EXTRACT_NODES);
        return children.map((child) => {
            const row: Record<string, unknown> = {};
            for (const nested of field.fields ?? []) {
                row[nested.name] = resolveFieldValue($, child, nested);
            }
            return row;
        });
    }

    if (nodes.length === 0) {
        return field.all ? [] : null;
    }

    const read = (target: AnyNode): unknown => {
        switch (field.type) {
            case 'attribute':
                return nodeToAttribute($, target, field.attribute ?? 'href') ?? null;
            case 'html':
                return $(target).html();
            case 'markdown': {
                const html = $(target).html() ?? '';
                try {
                    return htmlToMarkdown(html);
                } catch {
                    return normalizeText($(target).text());
                }
            }
            default:
                return normalizeText($(target).text());
        }
    };

    if (field.all) {
        return nodes.slice(0, MAX_EXTRACT_NODES).map(read);
    }
    const first = nodes[0];
    return first === undefined ? null : read(first);
}

/** 用 schema 从 HTML 中提取结构化数据。 */
export function extractWithSchema(html: string, schema: ExtractSchema): ExtractResult {
    const $ = cheerio.load(html);
    const baseNodes = schema.baseSelector
        ? $(schema.baseSelector).toArray().slice(0, MAX_EXTRACT_NODES)
        : [];

    const rootNode = $.root().get(0);
    const roots: AnyNode[] = schema.baseSelector
        ? baseNodes
        : (rootNode === undefined ? [] : [rootNode]);

    const items: Array<Record<string, unknown>> = [];
    for (const root of roots) {
        const row: Record<string, unknown> = {};
        for (const field of schema.fields) {
            row[field.name] = resolveFieldValue($, root, field);
        }
        items.push(row);
    }

    return {
        items,
        count: items.length,
        matchedBase: schema.baseSelector ? baseNodes.length : 1
    };
}

/**
 * 从抓取阶段可用的几种 HTML 中挑选最合适的一份：
 * 优先**原始页面 DOM**——用户写 selector 时看的就是真实页面，
 * Readability 的 DOM 已被裁剪，站点提纯器也可能重排结构。
 */
export function pickExtractionHtml(candidates: {
    raw?: string;
    sitePurifiedHtml?: string;
    readableHtml?: string;
    containerHtml?: string;
}): string | undefined {
    const looksLikeHtml = (value?: string): value is string => Boolean(value && /<[a-z!][^>]*>/i.test(value));
    if (looksLikeHtml(candidates.raw)) {
        return candidates.raw;
    }
    if (looksLikeHtml(candidates.sitePurifiedHtml)) {
        return candidates.sitePurifiedHtml;
    }
    if (looksLikeHtml(candidates.containerHtml)) {
        return candidates.containerHtml;
    }
    if (looksLikeHtml(candidates.readableHtml)) {
        return candidates.readableHtml;
    }
    return undefined;
}
