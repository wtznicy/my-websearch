/**
 * 把任意空白（换行、缩进、多空格）压缩为单个空格并去首尾。
 * 用于搜索引擎结果标题/摘要等单行文本的规范化。
 * 注意：段落保留型提取（如 fetchWebContent）不适用此函数。
 */
export function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}
