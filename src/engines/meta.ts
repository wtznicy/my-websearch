/**
 * Pure engine metadata shared by proxy routing and the engine registry.
 * Must stay dependency-free: systemProxy imports this file, while registry
 * imports concrete engine modules; importing registry from systemProxy would
 * recreate the registry → engines → httpRequest → systemProxy cycle.
 *
 * 事实来源是 `definitions.ts`（同样零依赖），这里只做派生。
 */

import { ENGINE_DEFINITIONS } from './definitions.js';

export const OVERSEAS_ENGINE_NAMES: readonly string[] = ENGINE_DEFINITIONS
    .filter((definition) => definition.region === 'overseas')
    .map((definition) => definition.id);

export type OverseasEngineName = string;

const overseasEngineSet = new Set<string>(OVERSEAS_ENGINE_NAMES);

export function isOverseasEngineName(engine: string | undefined): boolean {
    return engine !== undefined && overseasEngineSet.has(engine);
}
