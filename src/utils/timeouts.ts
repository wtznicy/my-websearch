/**
 * 统一超时与时间预算常量定义表。
 * 集中管理所有网络请求、引擎执行、级联补位、浏览器交互及会话生命周期的超时与 TTL 常量。
 */

/** 默认 HTTP(S) 请求超时（毫秒），调用方未显式传递 timeout 时的安全兜底 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/** 单引擎搜索执行硬超时（毫秒） */
export const PER_ENGINE_TIMEOUT_MS = 10000;

/** 全局搜索总时间预算（毫秒） */
export const SEARCH_DEADLINE_MS = 30000;

/** 级联补位单个批次所需的最小剩余预算（毫秒） */
export const MIN_CASCADE_BATCH_BUDGET_MS = 3000;

/** 境外引擎直连可达性探测超时（毫秒） */
export const OVERSEAS_PROBE_TIMEOUT_MS = 3000;

/** 境外引擎探测成功结果缓存 TTL（毫秒） */
export const OVERSEAS_PROBE_CACHE_TTL_MS = 5 * 60 * 1000;

/** 境外引擎探测失败结果短缓存 TTL（毫秒，1 分钟） */
export const OVERSEAS_PROBE_FAILURE_CACHE_TTL_MS = 60 * 1000;

/** 引擎遭遇 429 等终态反爬后的默认熔断冷却时间（毫秒，5 分钟） */
export const ENGINE_CIRCUIT_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/** 搜狗 PC 端遭遇反爬后的冷却切换时间（毫秒，10 分钟） */
export const SOGOU_PC_BLOCK_TTL_MS = 10 * 60 * 1000;

/** 通用网页抓取（fetchWebContent）超时（毫秒） */
export const FETCH_WEB_TIMEOUT_MS = 10000;

/** 掘金文章接口请求超时（毫秒） */
export const FETCH_JUEJIN_TIMEOUT_MS = 10000;

/** CSDN 抓取浏览器渲染兜底总时间预算（毫秒） */
export const CSDN_BROWSER_BUDGET_MS = 20000;

/** Playwright 浏览器远程连接超时基线（毫秒） */
export const PLAYWRIGHT_CONNECT_TIMEOUT_MS = 30000;

/** Playwright 页面导航默认超时（毫秒） */
export const PLAYWRIGHT_NAVIGATION_TIMEOUT_MS = 20000;

/** 本地浏览器 CDP 调试端点就绪等待上限（毫秒） */
export const PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS = 60000;

/** 本地浏览器 CDP 就绪初次探测等待（毫秒） */
export const PLAYWRIGHT_LOCAL_CDP_READINESS_INITIAL_PROBE_TIMEOUT_MS = 1000;

/** 本地浏览器 CDP 轮询间隔（毫秒） */
export const PLAYWRIGHT_LOCAL_CDP_READINESS_POLL_INTERVAL_MS = 1000;

/** HTTP MCP 传输会话空闲存活 TTL（毫秒，30 分钟） */
export const MCP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

/** HTTP MCP 传输过期会话扫描回收间隔（毫秒，5 分钟） */
export const MCP_SESSION_REAPER_INTERVAL_MS = 5 * 60 * 1000;
