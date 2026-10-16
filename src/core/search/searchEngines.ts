import {
    SUPPORTED_SEARCH_ENGINES,
    type SupportedSearchEngine,
    ENGINE_REGISTRY,
    getEngineDescriptor,
    getEngineLabel
} from '../../engines/registry.js';

export {
    SUPPORTED_SEARCH_ENGINES,
    type SupportedSearchEngine,
    ENGINE_REGISTRY,
    getEngineDescriptor,
    getEngineLabel
};

const ENGINE_ALIASES = new Map<string, SupportedSearchEngine>();
for (const engine of ENGINE_REGISTRY) {
    ENGINE_ALIASES.set(engine.name.toLowerCase().replace(/[\s._-]+/g, ''), engine.name);
    if (engine.aliases) {
        for (const alias of engine.aliases) {
            ENGINE_ALIASES.set(alias.toLowerCase().replace(/[\s._-]+/g, ''), engine.name);
        }
    }
}

export function normalizeEngineName(engine: string): string {
    const cleaned = engine.trim().toLowerCase();
    const compact = cleaned.replace(/[\s._-]+/g, '');
    return ENGINE_ALIASES.get(compact) ?? cleaned;
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
