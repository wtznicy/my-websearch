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

export function quoteModelLikeTerms(query: string): string {
    if (query.includes('"')) {
        return query;
    }
    return query.replace(MODEL_LIKE_TERM, '"$&"');
}
