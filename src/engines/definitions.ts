/**
 * 引擎的**纯事实**定义（single source of truth）。
 *
 * 本文件必须保持零依赖：`meta.ts` → `config.ts` → 几乎全部模块。
 * 这里只允许放「引擎是什么」（id / 区域 / 品类），**不要**放路由策略
 * （中英文默认组、级联优先级）——那是产品决策，会随版本调整，放进来会让 SSOT 变成配置大杂烩。
 * 执行器（searchBing 等）也留在 `registry.ts`，避免底层模块被迫加载全部引擎实现。
 */

export type EngineRegion = 'domestic' | 'overseas';
export type EngineCategory = 'general' | 'vertical';

export interface EngineDefinition {
    id: string;
    label: string;
    region: EngineRegion;
    category: EngineCategory;
    /**
     * 是否需要在墙内走代理（默认 true）。
     * API 型引擎（GitHub / StackExchange / HN Algolia / arXiv export）实测直连可达，
     * 走代理反而增加失败面；标 false 后默认代理名单与系统代理兜底都跳过它们。
     * 用户显式把它们写进 PROXY_ENGINES 时仍会走代理（显式配置优先）。
     */
    proxyInChina?: boolean;
    /**
     * 墙内是否**必须**走代理（默认 false）。
     * 这类引擎直连会超时/302，即使显式配置了 proxy.engines，也会被自动补进名单，
     * 避免用户升级后因为旧白名单缺少新引擎而静默失败。
     */
    proxyRequiredInChina?: boolean;
}

export const ENGINE_DEFINITIONS: readonly EngineDefinition[] = [
    { id: 'baidu', label: 'Baidu', region: 'domestic', category: 'general' },
    { id: 'bing', label: 'Bing', region: 'domestic', category: 'general' },
    { id: 'bing-news', label: 'Bing News', region: 'overseas', category: 'vertical', proxyRequiredInChina: true },
    { id: 'sogou', label: 'Sogou', region: 'domestic', category: 'general' },
    { id: 'csdn', label: 'CSDN', region: 'domestic', category: 'vertical' },
    { id: 'juejin', label: 'Juejin', region: 'domestic', category: 'vertical' },
    { id: 'duckduckgo', label: 'DuckDuckGo', region: 'overseas', category: 'general' },
    { id: 'brave', label: 'Brave', region: 'overseas', category: 'general' },
    { id: 'startpage', label: 'Startpage', region: 'overseas', category: 'general' },
    { id: 'yahoo', label: 'Yahoo', region: 'overseas', category: 'general', proxyRequiredInChina: true },
    { id: 'exa', label: 'Exa', region: 'overseas', category: 'general' },
    { id: 'github', label: 'GitHub', region: 'overseas', category: 'vertical', proxyInChina: false },
    { id: 'stackoverflow', label: 'Stack Overflow', region: 'overseas', category: 'vertical', proxyInChina: false },
    { id: 'hackernews', label: 'Hacker News', region: 'overseas', category: 'vertical', proxyInChina: false },
    { id: 'arxiv', label: 'arXiv', region: 'overseas', category: 'vertical', proxyInChina: false },
    { id: 'code', label: 'Code Search', region: 'overseas', category: 'vertical' }
];

const byId = new Map(ENGINE_DEFINITIONS.map((definition) => [definition.id, definition]));

export function getEngineDefinition(id: string): EngineDefinition | undefined {
    return byId.get(id);
}

export function listEngineIds(filter: { region?: EngineRegion; category?: EngineCategory } = {}): string[] {
    return ENGINE_DEFINITIONS
        .filter((definition) => (!filter.region || definition.region === filter.region))
        .filter((definition) => (!filter.category || definition.category === filter.category))
        .map((definition) => definition.id);
}
