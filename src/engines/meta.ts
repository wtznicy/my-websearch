/**
 * Pure engine metadata shared by proxy routing and the engine registry.
 * Must stay dependency-free: systemProxy imports this file, while registry
 * imports concrete engine modules; importing registry from systemProxy would
 * recreate the registry → engines → httpRequest → systemProxy cycle.
 */

export const OVERSEAS_ENGINE_NAMES = [
    'duckduckgo',
    'exa',
    'brave',
    'startpage',
    'github',
    'stackoverflow',
    'hackernews',
    'arxiv',
    'code'
] as const;

export type OverseasEngineName = typeof OVERSEAS_ENGINE_NAMES[number];

const overseasEngineSet = new Set<string>(OVERSEAS_ENGINE_NAMES);

export function isOverseasEngineName(engine: string | undefined): boolean {
    return engine !== undefined && overseasEngineSet.has(engine);
}
