/**
 * 检测并提取未识别入参的辅助函数。
 * 当 LLM 或外部调用方传入非工具规范定义的额外参数时，
 * 记录明确的警告提示并附加到 warnings 列表中，而不是直接报错打断流程。
 */
export function detectUnknownParameters(args: unknown, knownKeys: Iterable<string>): string[] {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return [];
    }
    const knownSet = new Set(knownKeys);
    const unknown = Object.keys(args as Record<string, unknown>).filter((k) => !knownSet.has(k));
    if (unknown.length === 0) {
        return [];
    }
    return [
        `Unknown parameter(s) ignored: ${unknown.map((k) => `'${k}'`).join(', ')}. Allowed parameters are: ${Array.from(knownSet).join(', ')}`
    ];
}
