/**
 * Pure engine metadata shared by proxy routing and the engine registry.
 * Must stay dependency-free: systemProxy imports this file, while registry
 * imports concrete engine modules; importing registry from systemProxy would
 * recreate the registry → engines → httpRequest → systemProxy cycle.
 *
 * 事实来源是 `definitions.ts`（同样零依赖），这里只做派生。
 */

import { ENGINE_DEFINITIONS } from './definitions.js';

/** 所有海外引擎（用于语言/区域判断） */
export const OVERSEAS_ENGINE_NAMES: readonly string[] = ENGINE_DEFINITIONS
    .filter((definition) => definition.region === 'overseas')
    .map((definition) => definition.id);

/**
 * 墙内默认需要代理的引擎（海外 + proxyInChina !== false）。
 * GitHub / StackExchange / HN Algolia / arXiv export 实测直连可达，默认不进代理名单。
 */
export const PROXY_ENGINE_NAMES: readonly string[] = ENGINE_DEFINITIONS
    .filter((definition) => definition.region === 'overseas' && definition.proxyInChina !== false)
    .map((definition) => definition.id);

/** 墙内必须走代理的引擎（直连超时/302，即使显式白名单也应自动补齐） */
export const PROXY_REQUIRED_ENGINE_NAMES: readonly string[] = ENGINE_DEFINITIONS
    .filter((definition) => definition.proxyRequiredInChina === true && definition.proxyInChina !== false)
    .map((definition) => definition.id);

export type OverseasEngineName = string;

const overseasEngineSet = new Set<string>(OVERSEAS_ENGINE_NAMES);
const proxyEngineSet = new Set<string>(PROXY_ENGINE_NAMES);

export function isOverseasEngineName(engine: string | undefined): boolean {
    return engine !== undefined && overseasEngineSet.has(engine);
}

/** 系统代理兜底是否应作用于该引擎（API 型引擎直连可达，不参与系统代理兜底） */
export function isProxyEligibleEngineName(engine: string | undefined): boolean {
    return engine !== undefined && proxyEngineSet.has(engine);
}
