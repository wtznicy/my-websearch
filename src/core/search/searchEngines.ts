export const SUPPORTED_SEARCH_ENGINES = [
    'baidu',
    'bing',
    'csdn',
    'duckduckgo',
    'exa',
    'brave',
    'juejin',
    'startpage',
    'sogou'
] as const;

export type SupportedSearchEngine = typeof SUPPORTED_SEARCH_ENGINES[number];

export function normalizeEngineName(engine: string): string {
    const cleaned = engine.trim().toLowerCase();
    const compact = cleaned.replace(/[\s._-]+/g, '');

    switch (compact) {
        case 'baidu':
            return 'baidu';
        case 'bing':
            return 'bing';
        case 'csdn':
            return 'csdn';
        case 'duckduckgo':
            return 'duckduckgo';
        case 'exa':
            return 'exa';
        case 'brave':
            return 'brave';
        case 'juejin':
            return 'juejin';
        case 'startpage':
            return 'startpage';
        case 'sogou':
        case 'sougou':
        case '搜狗':
            return 'sogou';
        default:
            return cleaned;
    }
}

export function distributeLimit(totalLimit: number, engineCount: number): number[] {
    if (engineCount <= 0) {
        return [];
    }
    // 每个引擎至少 1 条，避免"0 配额静默丢弃"（否则 limit < 引擎数时部分引擎根本没被调用）
    if (totalLimit < engineCount) {
        // 前 totalLimit 个引擎各 1 条，其余 0（调用方可通过 partialFailures 感知）
        return Array.from({ length: engineCount }, (_, index) => (index < totalLimit ? 1 : 0));
    }

    const base = Math.floor(totalLimit / engineCount);
    const remainder = totalLimit % engineCount;

    return Array.from({ length: engineCount }, (_, index) =>
        base + (index < remainder ? 1 : 0)
    );
}

export function resolveRequestedEngines(
    requestedEngines: string[],
    allowedSearchEngines: string[],
    defaultSearchEngine: string
): string[] {
    if (allowedSearchEngines.length === 0) {
        return requestedEngines;
    }

    const filteredEngines = requestedEngines.filter((engine) => allowedSearchEngines.includes(engine));
    return filteredEngines.length > 0 ? filteredEngines : [defaultSearchEngine];
}
