/**
 * 查询预处理：给"含数字的连字符/点号紧凑串"（型号/版本形态，如 GLM-4.6V-Flash、
 * DeepSeek-V4）自动加引号，让搜索引擎按精确短语匹配而非拆词——
 * 不加引号时 "GLM-4.6V-Flash" 会被拆成 GLM/4/6V/Flash 多个词，
 * 返回大量泛化的新版本信息（如搜 GLM-4.6V-Flash 却命中 GLM-5.2）。
 *
 * 约束（避免误伤）：
 * - 查询中已有引号时不处理（用户显式精确匹配优先）
 * - 不含数字的域名/普通词不匹配（docs.bigmodel.cn、hello 不受影响）
 * - site: 操作符后的域名不受影响（无数字），操作符本身不匹配
 */

const MODEL_LIKE_TERM = /(?<![\w.-])(?=[A-Za-z0-9.-]*\d)[A-Za-z][A-Za-z0-9.-]*[-.][A-Za-z0-9][A-Za-z0-9.-]*(?![\w.-])/g;

/**
 * 报错堆栈查询自动降噪：
 * 当 query 长度超过 80 字符或包含明显错误堆栈特征时，
 * 自动剥离本机私有路径（如 D:\Desktop\...）、文件行列号（:142:18）、十六进制内存地址与时间戳，
 * 保留纯粹的报错异常特征文本去检索，避免因私有路径导致 0 结果。
 */
export function cleanStackTraceNoise(query: string): string {
    const isLikelyTrace = query.length > 80
        || /[A-Za-z]:\\/.test(query)
        || /\b0x[0-9a-fA-F]{6,}\b/.test(query)
        || /\b(?:\w*Error|\w*Exception):/i.test(query)
        || /\bat\s+[A-Za-z0-9_$.<>]+\s*\([^)]+\)/.test(query);

    if (!isLikelyTrace) {
        return query;
    }

    let cleaned = query
        // 1. 移除 Windows 本机绝对路径（含可能附带的行列号）
        .replace(/[A-Za-z]:\\[^\s:()\[\]<>"']+(?::\d+(?::\d+)?)?/g, '')
        // 2. 移除 Unix 常见绝对/相对源码路径
        .replace(/(?:^|(?<=[\s(]))\/(?:Users|home|root|var|tmp|node_modules|src|dist|packages|app)\/[^\s:()\[\]<>"']+(?::\d+(?::\d+)?)?/g, '')
        // 3. 移除残留的独立行列号（如 :142:18 或 :142）
        .replace(/:\d+:\d+\b|:\d+\b(?=[\s)\]]|$)/g, '')
        // 4. 移除十六进制内存地址（如 0x7fff5fbff8a0）
        .replace(/\b0x[0-9a-fA-F]{6,16}\b/g, '')
        // 5. 移除 ISO 8601 时间戳
        .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '')
        // 6. 移除剥离路径后残留的空括号
        .replace(/\(\s*\)|\[\s*\]/g, ' ')
        // 7. 整理多余空白
        .replace(/\s{2,}/g, ' ')
        .trim();

    // 防御：若清洗后被完全擦除（如整句就只是一个路径），保底退回原 query
    return cleaned.length >= 5 ? cleaned : query;
}

export function quoteModelLikeTerms(query: string): string {
    if (query.includes('"')) {
        return query;
    }
    return query.replace(MODEL_LIKE_TERM, '"$&"');
}

/** 统一查询预处理管道：堆栈降噪 -> 型号引号包裹 */
export function preprocessSearchQuery(query: string): string {
    const denoised = cleanStackTraceNoise(query);
    return quoteModelLikeTerms(denoised);
}
