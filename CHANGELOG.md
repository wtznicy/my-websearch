# Changelog

All notable changes to `my-websearch` are documented in this file.

## [1.3.10] - 2026-10-26

### Fixed
- **`queryDocs` 裸库名稳定命中官方库**：Context7 search 常常不返回官方仓库（`tailwindcss` 只返回插件），旧逻辑会按分数随机落到 `/catppuccin/tailwindcss`、`/primefaces/tailwindcss-primeui` 等第三方包。现在裸库名命中内置官方映射时直接以官方 ID 作为候选（`tailwindcss` → `/tailwindlabs/tailwindcss`），并在同分时按 ID 排序保证确定性；缓存 key 升到 `v2`，旧缓存自动失效。
- **`bing-news` 默认走代理**：实测部分网络下 `www.bing.com` 直连会 302 到 `cn.bing.com` 并返回 HTML，无法解析 RSS。引擎改为 `region: overseas`（进入默认代理名单），返回 HTML 时明确报 `overseas_unreachable` 并提示配置代理/加入 `proxy.engines`，不再静默返回 0 条。
- **Yahoo / Bing News 错误提示**：直连超时或被挑战时，提示明确要求开启系统代理/`PROXY_URL`，并在使用显式 `proxy.engines` 时把对应引擎加进去。

### Changed
- **浏览器后端从 Playwright 切换为 raw CDP**：新增 `src/utils/browser/` 适配层（`chrome-remote-interface`），直接启动系统 Chrome/Edge，移除 `playwright-core` 依赖；Bing/Startpage 兜底、Cookie 获取、doctor 探测、daemon 关闭全部走 CDP。`PLAYWRIGHT_*` 变量名与 `SEARCH_MODE=playwright` 仅作为兼容别名保留；`BROWSER_DRIVER=playwright` 需要手动安装 playwright-core。
- **CDP 导航超时与清理**：`Page.navigate` 不再可能无限挂起（命令级 timeout + 事件监听清理）；CLI 关闭浏览器设置 6s 预算并强制退出，避免临时 profile 删除拖住进程。
- **DDG 文档改为 best-effort**：wreq GET 仍可能间歇性遇到 anomaly CAPTCHA；README 明确“不要当 SLA”，稳定场景用 Bing/Startpage 或官方 API key。

### Fixed
- **pnpm 严格依赖构建**：显式声明 `domhandler`（此前只是 cheerio 传递依赖，pnpm 下 TS2307，Glama/Docker 构建失败）。

## [1.3.9] - 2026-10-24

### Added
- **新增 `bing-news` 垂直引擎（第 16 个）**：Bing News RSS + `pubDate` **24 小时过滤** + `apiclick.aspx?url=` 真实链接解码，自带 description；不进默认路由/级联，通过 `engines:["bing-news"]` 显式调用，适合突发新闻与 24h 更新。
- **新增 `yahoo` 引擎（第 15 个）**：Yahoo 搜索是 SSR HTML，但必须先访问首页取得 `A1/A3` 等 cookie，否则直接 500；实现为「首页预热 + `div.algo` 解析 + `RU=` 重定向还原」，wreq 不可用时回退 axios cookie jar。它使用 Bing 索引，不参与默认路由/级联，只作为**英文主路由的健康替补**：DuckDuckGo 熔断或近期成功率过低时自动顶上（`AUTO_ROUTE_EN_ENGINES=bing,yahoo` 也可显式指定）。
- **`fetchGithubContent` 行号切片**：支持 URL hash `#L120-L180` 或 `lines: "120-180"`，只返回指定区间的源码并保留真实行号；越界严格报错，单次最多 400 行（超出截断并提示），GitHub/Gitee 一致。
- **`fetchGithubContent` 支持 Commit / Compare / Releases**：新增 `/commit/<sha>`、`/compare/<base>...<head>`、`/releases`、`/releases/tag/<tag>`（GitHub + Gitee）；Commit 输出提交信息、文件列表与限长 patch，Compare 输出 commits + 文件/补丁，Releases 输出 Markdown body 与 assets；patch 上限 30KB、文件上限 100，lockfile 自动跳过。
- **`queryDocs` 显式 `version` 参数**：`version` 优先于 `library` 里的 `@version`，Context7 与 npm/PyPI 兜底都会绑定该版本。
- **`queryDocs` 24h 本地缓存**：独立 `query_docs_cache` SQLite 表（Node 22 内置 `node:sqlite`，不可用时 JSON 文件兜底），只缓存置信度 ≥ medium 的成功结果；`cache: "reload"` 可绕过/刷新。
- **`queryDocs` 注册表兜底扩展**：新增 **crates.io**（Rust，带规范 User-Agent）与 **Go module proxy**（仅 github.com/gitlab.com 模块可直接推导仓库 README）两层。

### Fixed
- **Yahoo 遵循显式 `PROXY_ENGINES` 白名单**：旧配置里硬编码的 8 引擎名单不含 `yahoo`，而 Yahoo 逻辑此前会无条件套用 `PROXY_URL`/系统代理；现在显式名单优先，未配置名单时才用系统代理兜底。实测国内直连 Yahoo 15–20s 超时，走代理约 2s，因此自定义名单必须包含 `yahoo`（或直接删掉名单用默认）。

### Changed
- **统一日志入口 `core/log.ts`**：`LOG_LEVEL=debug|info|warn|error|silent|quiet|normal`，统一级别过滤、`[level] [my-websearch]` 前缀与 stderr 输出；CLI/MCP 入口安装 console bridge，存量 `console.*` 不再污染 `--json` 的 stdout。测试不安装 bridge，不影响 console spy。
- **模块拆分**：GitHub Issue/PR 渲染抽到 `engines/github/discussion.ts`（github.ts 1160→964 行）；Bing 的 site 操作符/URL 构造函数抽到 `engines/bing/query.ts`（bing.ts 1018→951 行）；浏览器临时目录安全删除抽到 `utils/playwright/browserSessionTemp.ts`（browserSession.ts 1824→1778 行），均保留原导出路径兼容。
- **测试脚本去重**：删除与 `npm test` 同义的 `test:unit`/`test:vitest`，以及与 `test:live` 同义的 `test:integration`；CI 改用 `npm test`。
- **文档清理**：README 测试基线更新为 87 文件 / 667 用例；删除空的 `docs/assets/`；`docs/architecture/overview.md` 去掉已完成的 Phase 1–4 历史计划，改为当前分层与不变量。
- **远端安全**：原 `origin` 指向上游 `Aas-ee/open-webSearch`（217/466 提交分叉，误 push 风险高），已重命名为 `upstream`；`gitee` / `github` 为仅有的推送远端。

## [1.3.8] - 2026-10-24

### Fixed
- **Brave 固定走 HTTP/1.1（axios），不再复用 wreq 指纹路径**：同一节点同一时刻实测 wreq（HTTP/2 Chrome 指纹）→ 429，而 axios/curl 的 HTTP/1.1 → 200（连续 6 次）；CloudFront WAF 对 HTTP/2 指纹更敏感。DDG 的方向相反（必须 wreq），两者不能共用同一请求栈。
- **DDG 的 202 根因是 TLS/方法组合，不是 IP**：实测同一出口下 axios POST `html.duckduckgo.com` → 202，而 wreq-js 的 Chrome profile **GET** → 200（32KB 结果页）。现在 DDG 优先用 wreq 指纹 GET（显式代理或系统代理），失败才回退 axios；并还原 `//duckduckgo.com/l/?uddg=` 重定向链接，避免结果被 URL 校验丢弃。实测 `--engine duckduckgo` 从 202/0 条变为 3 条、约 2.1s。
- **DuckDuckGo 202 诊断不再误导**：实测 202 响应体是 `anomaly CAPTCHA`（点选图片的人机验证），不是普通 IP 限流，也不是 `d.js` 算术挑战；内置求解器无法绕过，换节点也只在换到未标记出口时有效。错误文案改为说明这是 anomaly CAPTCHA、建议改用 bing/brave 或配 `BRAVE_API_KEY`/`EXA_API_KEY`，不再承诺"换节点即可"。
- **`queryDocs` 不再把第三方同名包当官方库（high confidence）**：裸库名 `tailwindcss` 曾解析到 `/catppuccin/tailwindcss`。现在裸库名优先命中官方映射（tailwindlabs、facebook、vuejs 等 22 个高风险库），同名多 owner 命中时置信度最高 `medium`，并附带候选列表与「改用完整 Context7 ID」的 warning；完整 `/owner/repo` 仍精确优先。
- **`limit` 语义写清楚 + 被取消引擎进 `engineMetrics`**：工具描述改为「合并后的目标总数，不是每引擎配额」；早退取消的引擎现在以 `cancelled: true` 出现在 `engineMetrics`，不再凭空消失（配合已有的 `cancelledEngines`）。
- **被早退取消的引擎不再「看起来像返回 0 条」**：主引擎/级联因结果足够而 abort 的引擎，现在写入 `cancelledEngines`（含 engine/reason/message）并追加 warning，CLI 也会打印「Cancelled engines」；此前这些引擎既无结果也无失败记录，外部无法区分「0 条」与「没来得及」。
- **显式点名引擎时禁用早退**：用户用 `engines`/`--engines` 点名的引擎不再被兄弟引擎的早退 abort（此前 `--engines github,stackoverflow` 里 SO 常被 github 的快速结果取消，表现为 0 条）；代价是显式多引擎会等到各自完成。
- **系统代理不再「只检测、不使用」**：搜索与抓取入口会先 `ensureSystemProxyDetected()` 预热检测，首次请求即可走系统代理；此前缓存为空时首发直连失败（如 react.dev 的 TLS reset），事后才在错误提示里补检测。
- **海外引擎闸门不再用 3s 探测误杀系统代理**：检测到系统代理时直接放行，由真实请求（10s 预算 + 完整错误映射）判断；只有完全无代理时才直连探测并快速失败。错误文案改为「未检测到系统代理」，不再声称「通过代理也不可达」。

### Changed
- **API 型引擎默认改走直连**：GitHub（api.github.com）、Stack Overflow（api.stackexchange.com）、Hacker News（hn.algolia.com）、arXiv（export.arxiv.org）实测墙内可直连，现在默认代理名单不再包含它们，系统代理兜底也跳过它们；只有显式写进 `PROXY_ENGINES` 才走代理。README 对这四个引擎的标注从「Proxy in CN」改为「Direct API」。
- 显式 `PROXY_URL` 仍按 `PROXY_ENGINES` 白名单生效（默认仅海外引擎），国内引擎保持直连；不配 `PROXY_URL` 时则自动使用系统代理。
- **权威域名白名单扩充**：补入 tailwindcss.com、react.dev、vuejs.org、angular.dev、nextjs.org、typescriptlang.org、fastapi.tiangolo.com、kubernetes.io 等 25 个官方文档站，缓解中文查询被 runoob/镜像站挤占（可用 `SEARCH_AUTHORITY_DOMAINS` 继续追加）。
- **文档修正**：README 的「13-Engine」改为 14；`code` 引擎标记从「🇨🇳 直连」改为「🌐 国内需代理」；代理排障从「没有 `PROXY_URL` 就没有系统代理」改为「系统代理自动检测」，并补充 WorkBuddy 信任指纹（`env` 键名参与指纹）建议改用 `~/.my-websearch/config.json`；DuckDuckGo 的 202 说明改为 anomaly CAPTCHA（不绕过）、并注明 `playwright:duckduckgo` 不受支持。

## [1.3.7] - 2026-10-23

### Fixed
- **GitHub/Gitee 内容抓取加总预算 + host 熔断**：README 此前 7 个候选 × 3 个 ref × 10s（网络错误再 ×2）最坏可叠到 90~180s；现在共享 `GITHUB_CONTENT_BUDGET_MS`（默认 12s，CDN-first 6s）、单次上限 4.5s，失败 host 本次调用内不再重试。
- **blob 尊重 CDN-first**：源码文件此前固定 raw 15s + jsDelivr 15s，开关完全不生效；现在与 README 共用开关与预算，CDN-first 时直接走 CDN，预算有剩余才回退 raw。
- **jsDelivr 多域名失败转移**：`cdn.jsdelivr.net` → `fastly.jsdelivr.net` → `gcore.jsdelivr.net`，仅在网络层失败时轮转（404 不换域名）。
- **PR 变更文件列表级截断**：只列前 30 个 + `… and N more`，不再被全局字符上限砍在半行；Gitee 的 `files` 端点忽略 `per_page` 的现状已在代码中注明，并用 `changed_files` 标注“first N of M”。
- `directAnswer` 不再泄漏 CSS：`.text()` 会把 `<style>` 内容当文本返回（实测 `#rscarousel strong{...}`）；新增 `textFromSelection`（先删 style/script/noscript/svg 再取文本）与 `stripCssFragments` 兜底，Bing/Baidu 答案卡和出口层都清洗。
- **Bing 不再把答案卡/轮播链接当自然结果**：`RESULT_SELECTORS` 只保留 `li.b_algo`，并排除 `.b_ans`/`#rscarousel`/`.b_related` 容器（此前购物卡商品页会混进结果）。
- **`extract`/`selector`/`readability`/`includeLinks` 强制 HTML 内容协商**：默认 `Accept` 优先 Markdown，站点（实测 benchlm.ai）会直接返回 `text/markdown` 导致 `extract` 报错；现在这类请求发 `text/html` 优先，并跳过 alternate Markdown 覆盖。
- **Stack Overflow 查询放松**：`q` 是全词 AND，`asyncio gather vs create_task difference` 实测 0 条；现在按「原查询 → 去比较词 → 去停用词 → 标识符组合」逐级降级并返回 relaxed warning。
- `no_results` 文案不再误导成配额问题（`for the allocated quota` → 说明查询/过滤过窄并带上请求数量）。

### Changed
- **GitHub 概念型查询质量**：剥掉 `best practices/guide/tutorial` 等意图词后按主题词重搜并合并；低星仓库（<10/＜50）降权；非排错类查询不再用 Issue 补齐结果。
- **Stack Overflow 质量信号**：0 回答/负分问题降权。
- **工具描述与 CLI 帮助补 Gitee 示例**：明确 GitHub `/pull/<n>` 与 Gitee `/pulls/<n>` 的路径差异，避免模型只锚定 GitHub 示例。
- 新环境变量 `GITHUB_CONTENT_CDN_FIRST`（旧名 `GITHUB_README_CDN_FIRST` 兼容）与 `GITHUB_CONTENT_BUDGET_MS`。

## [1.3.6] - 2026-10-23

### Fixed
- **Bing 漂移回退不再丢弃已成功的 HTTP 结果。** `auto` 模式检测到首词漂移后，Playwright 兜底改走独立预算（8s），兜底失败/超预算时保留 HTTP 结果并写入一条 warning，而不是整批丢弃（实测 2.9s→25.9s、12s deadline 下 0 条）。
- **`timeRange` 不再因「缺少发布日期」清空结果。** 只丢弃明确超出范围的条目；日期未知的保留并给出说明。修复 Bing/Baidu/Sogou 在 `timeRange` 下恒定返回 0 条。
- **DNS 污染双层判定不一致。** 连接前剔除 Teredo/黑洞地址，并把连接层的 `private IP` 报错映射为 `dns_pollution`（建议开代理）。
- **429 不再升级到浏览器兜底。** 配额型拒绝直接返回可重试错误；GitHub 提示配置 `GITHUB_TOKEN`。
- **`focus` 未命中改为显式标记。** 输出 `focused: false`、`focusBlocks: {selected: 0, total: N}` 和 warning，不再静默返回整页。
- **引擎延迟统计剔除 <10ms 的噪声样本**（测试假引擎/缓存命中），`doctor` 的 p50 不再被拉到 0。

### Added
- **发布日期多路抽取**：搜索层从 URL 路径/标题/摘要做纯本地解析（严格年月日边界，拒绝 `/item/2000/10/`、`v2.10.21` 这类误判）；抓取层从 JSON-LD、`article:published_time`、`<time datetime>` 抽取，经 `fetchWebContent.publishedAt` 返回，并随页面缓存持久化（缓存命中不再丢日期）。实测覆盖率 10/15 = 67%（无代理）。
- **引擎事实 SSOT**：新增零依赖的 `src/engines/definitions.ts`（id / label / region / category），海外清单与默认代理名单均由它派生；新增守卫测试保证定义 ↔ registry ↔ 代理名单 ↔ 国内通用池一致。
- **可选 RRF 融合**（`SEARCH_FUSION=rrf`）：保留每个引擎内的排名并计算 `Σ 1/(k+rank)`（k 默认 20）；重排阶段用 `0.45*rrfNorm + 0.35*BM25 + 0.20*权威度` 替换 position+consensus，避免重复计分。
- **CLI `--time-range day|week|month|year`**：此前只有 MCP 工具支持时间过滤。
- **显式引擎与语种不匹配提示**：只点名中文引擎却搜英文时返回可操作 warning，建议改用 bing/duckduckgo/brave。
- **`npm run canary`**：固定查询集 × 引擎，对比 `.canary-baseline.json`，骤降 >50% 时退出码 1。

### Performance
- 引擎请求改用可信域名专用 keepAlive + DNS 缓存 agent（此前落到 axios 默认 agent，每次重新 DNS/TLS 握手）。
- `fetchWebContent` 增加全局 deadline（默认 45s，`FETCH_WEB_DEADLINE_MS` 可调），避免 cookie/浏览器/主请求/回退四段预算叠加到 ~65s。
- 页面缓存：SQLite 开 WAL + `busy_timeout=5000`、启动清理过期行、JSON 后端 tmp+rename 原子写；命中 touch 60s 节流。
- bing 增加并发闸门（4）；bing/baidu 的 wreq 超时从硬编码 15s 对齐到引擎预算 10s。

### Security
- 页面缓存写入失败不再拖垮整个抓取响应（`safeCacheSet`）。
- 重定向钩子拒绝单标签主机名；daemon 绑定非回环地址时打印无鉴权警告；SSRF 拦截进入 Prometheus（`mywebsearch_ssrf_blocked_total`）。
- 未知 MCP session 返回 404（规范语义）；README 增加安全模型章节；`MYWEBSEARCH_NO_AUTO_BOOTSTRAP=1` 可关闭跨应用密钥复制。

### Changed
- 文档：引擎数 13 → 14（补 `code`）；`docs/architecture/overview.md` 标注四阶段已完成。
- **RRF 默认仍为 `legacy`**：在 10 条固定查询、固定 bing+baidu 输入的对照实验中，两种模式结果集合基本一致（overlap@5 = 4.70/5），但 authority@3 为 legacy 0.20 vs rrf 0.17；且两引擎 URL 重合度极低（consensus@3 恒为 0），RRF 的共识信号没有发挥空间。待主引擎组扩大或积累更大评测集后再考虑切换默认。

## [1.3.5] - 2026-10-21

### Performance
- 抓取去掉 HEAD 预检：每页少一个 RTT（应用层开销 570ms → 32ms）。
- 每个引擎按完整 `limit` 请求 + 「满意即止」：结果足够后给慢引擎 800ms 宽限，到期 abort。auto 中文 17.3s → 3.6s，英文 8.5s → 4.0s。
- 死代理快速失败：连接类代理错误不再重试 3 次（30s → ~10s）。

### Fixed
- `--engines` 改为硬限制：级联只在点名的引擎内补位。
- 代理不可达但直连有结果时返回可操作 warning。
- `doctor` 正确汇报系统代理状态；代理未启用时不再显示不生效的默认 `proxyUrl`。
- 系统代理检测改为 60s TTL：启动后再开代理一分钟内生效，无需重启。
- 区分 `engine_timeout`（预算耗尽）与真实网络错误。
- arXiv 引擎改用 https，避免 301 跳转在代理路径上偶发 4xx。
- 直连失败时也回退到自动检测的系统代理。

### Added
- `doctor` 展示每个引擎最近 7 天的 p50 / p95 / 成功率（持久化到 `~/.my-websearch/engine-latency.jsonl`）。
- `Accept-Language` 跟随系统区域（`ACCEPT_LANGUAGE` 可覆盖；Bing 保持随机化）。
- `tools/bench.mjs` 性能基线工具。

## [1.3.4] - 2026-10-20

### Behavior changes (read before upgrading)
- **`focus` now defaults to BM25 block selection.** Callers that rely on the previous output must pass `focusMode: 'window'`. This is a patch-version release but the default output of `focus` changed, so pin `focusMode` if you depend on byte-stable results.
- **`REGISTER_LEGACY_ARTICLE_TOOLS` removed.** The `fetchCsdnArticle` / `fetchJuejinArticle` legacy tools can no longer be exposed; CSDN/Juejin URLs are routed through `fetchWebContent` by domain.
- **`readableHtml` removed** from the fetch result (and `includeReadableHtml` from the internal options). It was never reachable from the MCP schema or the CLI.
- **`readability: true` / `includeLinks: true` / `selector` requests no longer read or write the page cache.** The cache key is `(url, format)` and does not record *how* the page was extracted, so a cache hit could previously return a body produced by a different extraction mode (and lose `links` / `scoped` metadata).

### Playwright fallback: useless subresources are blocked
- New `utils/browserResourceBlocker.ts` aborts image / media / font / stylesheet requests inside the browser fallback path (borrowed from Scrapling's approach), which cuts page-load time on heavy sites. Cookie handling and stealth flags were adjusted around it, and the behaviour is covered by `browser-resource-blocking.test.ts` (11 cases).

### Internal refactors (no behaviour change)
- The 1,252-line `fetchWebContent` god function is split into an explicit stage pipeline (`validateAndFetchPrimary` → `tryHandlePdfFetch` → `fetchAndExtractHtmlWithBrowserFallback` → `validateFetchOutcome` → `assembleFetchResult`) with dedicated `transport.ts` / `types.ts` / `pagination.ts`. PDF paging and focus contract tests were extended alongside the split.
- The engine registry no longer imports from core search (`engines/meta.ts` added), breaking the engine ↔ search circular dependency; blackhole mixed-response regression coverage added.
- Removed a fragile architecture diagram from both READMEs (it failed to load often and reflowed badly).

### Removed dead surface (no behaviour change)
- **Removed `src/types/playwright.d.ts`**: it declared `module 'playwright'`, but nothing imports `playwright` (everything uses `playwright-core`, which ships its own types). Deleting it leaves `tsc` clean.
- **Removed three unreferenced sponsor images** under `docs/assets/sponsors/` (429 KB total) — no README, manifest or doc referenced them.
- **`src/types/koffi.d.ts` stays** (and now says so in a header comment): `nativeInterop.ts` references `typeof import('koffi')` as a type, and koffi is an optional dependency that may not install in CI. Removing the shim would turn a missing optional package into a `TS2307` build failure. The trade-off — it shadows koffi's real types — is documented instead.
- **Legacy MCP tool handlers removed**: `fetchCsdnTool`, `fetchJuejinTool` and the already-orphaned `resolveLibraryTool` are gone, together with the `REGISTER_LEGACY_ARTICLE_TOOLS` switch. They were only registered when that flag was set, so they never ran — yet they still counted against the tool-description budget and had to be kept compiling. CSDN/Juejin routing stays where it belongs, inside `fetchWebContent` by domain.
- **`includeReadableHtml` removed**: it was not reachable from the MCP schema or the CLI (only internal callers and one legacy test used it), and its own comment warned it "can be tens of KB of tokens". The `readableHtml` result field goes with it.
- **Shared HTTP middleware**: the two HTTP entry points (`src/index.ts` MCP transport, `localDaemon.ts` REST) each re-implemented `express.json()` plus the `OPEN_WEBSEARCH_ALLOWED_HOSTS` allow-list and `hostHeaderValidation`. That is security-relevant logic drifting in two places, so it now lives in `adapters/http/sharedMiddleware.ts` (`applyJsonBody` / `applyHostValidation` / `resolveAllowedHostnames`) and is covered by `http-middleware.test.ts`.

### `selector` scoping and `retainLinks` link retention
- **`selector`**: scope extraction to a CSS-selected subtree and keep returning markdown (code blocks, tables and all). This is the escape hatch for the pages where automatic container detection picks the wrong thing — a sidebar TOC longer than the article, an issue page where comments win over the body. All matched nodes are concatenated in document order, so list selectors like `div.quote` keep every item. `scoped: {selector, matched}` is echoed back.
- A selector that matches nothing now fails with `selector_not_found` **instead of silently falling back to the whole page**, and the hint lists the containers the page actually has (`This page has: [role="main"]`). Silent fallback would let the caller believe it got scoped content and reason from a wrong premise. Malformed selectors reject as `invalid_arguments`; PDF targets and non-HTML responses reject as `extraction_failed`.
- **`retainLinks: 'all' | 'text' | 'none'`**: `text` keeps anchor text and drops URLs, `none` removes the link construct entirely. Measured on `sindresorhus/awesome`: 78,320 → 38,914 characters (**-50.3%**, 704 links rewritten) — link-heavy index pages are where this pays; on a prose doc like Python's `os` page URLs are only 5.2% of the payload. Images and fenced code blocks are never touched.
- `selector` and `extract` are mutually exclusive (extract has its own `baseSelector`), as are `selector` and `raw`, and `citations` with `retainLinks: 'text'|'none'` (you cannot cite URLs you just stripped). All three reject at the pipeline entry with `invalid_arguments`, so MCP, CLI and daemon behave identically.
- Two cache bugs found while verifying against real pages, both the same root cause — the cache key is `(url, format)` and does not include *how* the page was extracted: `selector` requests were served cached **unscoped** markdown, and `scoped` metadata was dropped by the slice step (same class as the earlier `links`/`readabilityApplied` loss). Both fixed and covered by tests.
- Threaded through MCP (`fetchWebContent`), CLI (`fetch-web --selector/--retain-links`) and the daemon (`POST /fetch-web`). Tool description remains inside the 250-char budget.

### Fix: `includeLinks` / `readability` metadata were silently dropped
- The two-stage pipeline (fetch full text → slice) rebuilds the result object in `sliceMarkdownContent`, which discarded `links`, `byline`, `excerpt`, `readabilityApplied` and `degraded` coming from the extraction stage. As a result `fetchWebContent --include-links` (MCP, CLI and daemon alike) returned no `links` at all. They are now passed through explicitly.
- Cache keys are `(url, format)` and do not include `readability` / `includeLinks`, so a cached plain-text body could be served to a readability request. Both flags now bypass the page cache, matching how `extract` already behaved.
- Added `fetch-pipeline-metadata.test.ts`, which also asserts the cache is working before asserting the bypass, so the test cannot pass vacuously.

### Test Suite: deterministic legacy scripts are now enforced in CI
- `src/test/test-*.ts` is the repo's original self-verifying test generation (`assert` + `process.exit`) rather than vitest cases. Several of them cover modules no vitest file imports (`utils/text`, `utils/queryPreprocess`, `utils/dnsCache`, `core/validation/targetValidation`), but CI only ran `test:vitest`, so that coverage gated nothing.
- New `npm run test:deterministic` runs an explicit 16-script whitelist of offline, browser-free scripts via `src/tools/runDeterministicTests.ts`; `check:ci` and the GitHub workflow now run it after the build. Live network scripts stay out of CI under `npm run test:live`.
- Removed six scripts that no longer asserted reality: `test-cli-search`, `test-local-daemon`, `test-mcp-adapter`, `test-http-request-options`, `test-runtime` (all pinned pre-refactor internal contracts such as "`maxChars` is forwarded verbatim to the fetcher" or the removed `partialFailures` field) and `test-bing-playwright-cross-restart-concurrency` (already excluded from every runner and superseded).
- `test-core-search` and `test-core-fetch-services` were repaired rather than dropped: one stale engine list (`code` engine added) and three assertions that documented the old single-stage fetch contract.
- Confirmed coverage gaps that used to be guarded by the deleted scripts: local daemon route happy paths and MCP payload shapes. These now need to be rewritten as vitest cases (which fail per-assertion instead of aborting the whole script) if they are wanted back.

### Content Pipeline: BM25 Focus, CSS-Schema Extraction, Citations
- **`focus` now defaults to BM25 block selection** (`focusMode: 'bm25'`): text is split into paragraph blocks (headings stay attached to their section), scored by BM25 with CJK bigram tokenization, and the highest-scoring blocks are reassembled in document order. This fixes the three limits of the old behaviour — it only matched the *first* literal occurrence, returned one contiguous ±2500-char window, and lost the rest of a page where the term appears in several places. Blocks containing the literal phrase still rank first, so multi-word focuses that never appear as an exact phrase now match via partial terms. `focusMode: 'window'` preserves the old output byte for byte. Results carry `focusMode` and `focusBlocks: {selected, total}`; BM25 selections do not emit a `nextStartIndex` because the selected blocks are non-contiguous.
- **`extract`: structured JSON via CSS selectors, no LLM** (`{baseSelector, fields:[{name, selector, type, attribute, fields, all}]}`). Shaped after crawl4ai's `JsonCssExtractionStrategy`. Supports `text` / `html` / `markdown` / `attribute` / `list` (nested) field types, the `@attr` shorthand for reading an attribute of the current node, and `all: true` for repeated values. Extraction prefers the raw page DOM, bypasses the page cache and the CSDN/Juejin/GitHub forwarders (they only produce text), and returns `contentType: application/json` with `extracted` + `extraction: {count, matchedBase}`. Schemas are validated up front (field count, nesting depth, required selector/attribute) and reject with `invalid_arguments`.
- **`citations`: numbered references** — inline links become `label [n]` plus a `## References` list of absolute URLs; site-relative links are resolved against the page URL, images and `#`/`mailto:` targets are left alone, fenced code blocks are skipped, and the reference cap keeps numbering consistent (no dangling `[n]`). Applied **after** pagination so the disk cache never stores cited text.
- Both features are threaded through MCP (`fetchWebContent`), CLI (`fetch-web --focus/--focus-mode/--citations/--extract`), and the local daemon (`POST /fetch-web`). Truncated slices no longer end on a half-cut markdown link.
- Tool description stays inside the 250-char / 1000-char total budget enforced by `tool-descriptions-budget.test.ts`.

### One-Command Client Setup (`my-websearch init`)
- New `init` command detects installed MCP clients and writes the server entry into `claude_desktop_config.json`, `~/.cursor/mcp.json`, or the workspace `.vscode/mcp.json`, printing a per-target diff.
- Safety: refuses to modify a config that is not valid JSON, never overwrites a differing existing entry without `--force`, and always writes a `.bak.<timestamp>` backup first.
- Legacy keys (`mywebsearch`, `open-websearch`, `open-webSearch`) are detected and migrated to the canonical `my-websearch` key instead of leaving a duplicate entry behind.
- Windows: writes `cmd /c npx …` automatically, replacing the README's "decide for yourself whether `npx` is on PATH" caveat; warns when `npx` cannot be found at all. Other platforms keep plain `npx` so a later Node upgrade through nvm/fnm does not break the config.
- `--dry-run` previews without writing, `--json` emits the standard envelope, `--home DIR` targets another profile; `init` deliberately does not need the full runtime.

### GitHub Exact Repository Lookup
- The `github` engine now recognizes `owner/repo` and GitHub URLs, calls `/repos/{owner}/{repo}` first, and places the canonical repository at the top with an internal ranking boost.
- `limit=1` returns the exact repository without a Search API call, saving quota; 404 falls back to normal search, and 401/403 retries anonymously when a token is invalid or exhausted.
- Added parser, exact-lookup, and ranking-boost tests.

## [1.3.3] - 2026-10-19

### Search Engine Reliability (Bing / Startpage / DuckDuckGo)
- **Bing**: when the wreq impersonation path returns an empty array (HTTP 200 but no parsed results), it no longer short-circuits; it falls back to the axios SERP path. Five technical queries that previously returned 0 now all return results.
- **Startpage**: Anubis PoW is split across up to 4 worker threads (difficulty 6 ≈ 3–12s), default max difficulty raised from 5 to 6, nonce cap raised from 20M to 48M, and Anubis steps retry on socket errors or transient 5xx. Two live runs succeeded in 8.8s / 11.9s without launching Playwright.
- **DuckDuckGo**: root cause confirmed as exit-IP rate limiting (`anomalyDetectionBlock` from `d.js`); the engine now returns an actionable hint to rotate the proxy node / wait. No client-side bypass is available for this upstream IP ban.
- **Adaptive circuit breaker**: HTTP 429 / 202 / `bot_challenge` now trip the engine circuit with a **30s base cooldown**; consecutive failures back off 60s → 120s → 240s → 300s and any successful call resets the counter. Configurable via `ENGINE_CIRCUIT_BASE_COOLDOWN_MS` / `ENGINE_CIRCUIT_MAX_COOLDOWN_MS`. Replaces the previous fixed 5-minute block, which made a transient DDG 202 prohibitively expensive.

### First-Use Discoverability & GitHub 404 Guidance
- **Tool rename**: default MCP tool name changed from `fetchGithubReadme` to `fetchGithubContent`. Restore the old name with `MCP_TOOL_FETCH_GITHUB_NAME=fetchGithubReadme`; CLI adds `fetch-github-content` (alias: `fetch-github-readme`); daemon serves both endpoints.
- **Tool description**: now includes a concrete `/blob/` example, ref semantics (branch/tag/commit), and the "one file or directory per call, not a repo clone" boundary — still within the 250-character budget.
- **Teaching 404**: missing `/blob/` paths now return sibling file candidates from the GitHub Contents API plus a ready-to-use `/blob/...` example; missing `/tree/` paths return a ref/path hint. The hint is surfaced by MCP, `fetchWebContent`, CLI, and daemon.
- **Tests**: the description-budget test asserts the new name and discoverability phrases; added a missing-blob sibling-candidate test.

### Gitee Content Parity (Blob / Tree / Issue / PR)
- `fetchGithubContent` now supports Gitee beyond README: source files (`/blob/<ref>/<path>`), directory trees (`/tree/<ref>/<path>`), issues (`/issues/<id>`, including alphanumeric IDs such as `IDLSUI`), and pull requests (`/pulls/<n>`).
- Gitee files use the Contents API (base64) with a raw-download fallback for large files; trees reuse the same ASCII renderer and 150-item cap; issues include labels/comments; PRs include branch, change totals, and changed files.
- Added optional `GITEE_TOKEN` (higher API limits / private repos). Missing Gitee files return sibling candidates, matching the GitHub teaching-404 behavior.
- Shared formatters moved to `engines/github/format.ts` (re-exported from `github.ts`) to avoid host-adapter cycles; fixed the self-referencing subtree entry and directory size rendering for both GitHub and Gitee.
- Tests: 4 new Gitee parity cases (blob/tree/issue/PR).

### Code Search Engine (grep.app) Anti-Bot & SSRF Fix
- **maxRedirects: 0 & Checkpoint Detection**: Configured `maxRedirects: 0` and `stopOnRedirect: true` for grep.app requests to prevent following 3xx redirects to `www.google.com/sorry/index`.
- **SSRF False-Positive Prevention**: Avoids resolving `www.google.com` (which previously triggered `DNS lookup 2001::1 is not allowed` in IPv6/TUN environments).
- **Accurate Error Mapping**: Identifies 3xx/Google sorry redirects as non-retryable `bot_challenge` structured errors rather than crashing with network/SSRF errors.
- **Vercel 429 Challenge Split**: Reads `x-vercel-mitigated: challenge`; challenge responses map to non-retryable `bot_challenge`, plain 429 to retryable `rate_limited`, each with an actionable hint.
- **TLS Fingerprint Bypass**: grep.app/Vercel rejects plain Node/axios requests (429) even with correct headers; the engine now prefers the existing wreq-js Chrome TLS/HTTP2 session, falling back to the SSRF-guarded direct/proxy request only on network-layer failures. Added the `Accept-Language` browser header as well.
- **Current API Schema**: Parses grep.app's flat `repo`/`path`/`branch` fields and turns the HTML `highlight-table` snippet into line-numbered plain text (old `{ raw }` shape still supported); result URLs now use the real branch.
- **Cleanup**: Removed the redundant `trustedStaticHost` flag and the unused `grep.app` entry in `TRUSTED_INSECURE_HOSTS`; `maxRedirects: 0` remains explicit.

## [1.3.2] - 2026-10-18

### 🚀 Major Improvements & New Features

#### 1. 4 Core MCP Tools (Slim & Token-Efficient)
- **Tool Description Slimming**: All 4 tool descriptions are strictly kept under 250 characters each (total length ≤ 1000 characters), cutting LLM tool context overhead by over 60%.
- **Server Instructions**: Comprehensive routing strategies and engine characteristics are moved into `McpServer({ instructions })`.
- **Enforced 4-Tool Boundary**: Retains strictly 4 tools (`search`, `fetchWebContent`, `fetchGithubReadme`, `queryDocs`).

#### 2. `search` Tool Upgrades
- **New Code Search Engine (`code`)**: Added grep.app code search API into `search` engines (`engines: ['code']`). Returns matching GitHub repositories, file paths, line anchors (`#L...`), and matched code snippets.
- **Time Filtering (`timeRange`) Native Engine Mapping**: Added `timeRange: 'day' | 'week' | 'month' | 'year'`.
  - Natively maps query parameters across 8 upstream engines:
    - Bing: `filters=ex1:"ez1/ez2/ez3/ez5"`
    - Brave: `freshness=pd/pw/pm/py` (both official API & web search)
    - DuckDuckGo: `df=d/w/m/y` (both HTML POST & preload requests)
    - GitHub: `created:>=YYYY-MM-DD` appended to query
    - arXiv: `AND submittedDate:[YYYYMMDD0000 TO YYYYMMDD2359]`
    - StackOverflow: `fromdate=<unix_timestamp>`
    - HackerNews: `numericFilters=created_at_i>=<unix_timestamp>`
    - Exa: `startPublishedDate=<ISO_8601>`
  - Domestic engines (Baidu, Sogou, CSDN, Juejin) perform client-side post-filtering and normalization to ISO `YYYY-MM-DD` (`publishedAt`). If date metadata is missing under `timeRange`, filters appropriately and reports `filterFallback: "partial"`.
- **End-to-End RequestContext**:
  - `RequestContext` ({ `signal`, `deadlineAt`, `traceId`, `tokenBudget`, `warnings` }) flows seamlessly from MCP `extra.signal` through `searchTool` / `fetchWebTool` down into `searchService.execute`, `executePrimaryEngines`, `executeCascade`, and underlying engine execution contexts.
- **Graceful Unknown Arguments Handling (`warnings`)**:
  - All 4 tools (`search`, `fetchWebContent`, `fetchGithubReadme`, `queryDocs`) use `.passthrough()` on their Zod input schemas to detect unexpected parameters and return actionable hints in `warnings` (e.g. `Unknown parameter(s) ignored: ...`) rather than failing outright.
- **Site Filtering (`site`)**: Added `site: string[]` support (e.g. `site: ["docs.python.org", "github.com"]`).
- **Inline Network Diagnostics on Failure**: When all engines fail or network errors occur, an inline 300ms TCP probe + 1.5s HEAD probe runs automatically without blocking happy paths, returning `diagnostics: { proxy, dns, suggestion }`.
- **Breaking Behavior Change for Cascading**:
  - When `engines` is explicitly provided and `minResults` is not passed, `minResults` now defaults to `0` (cascading is disabled by default).
  - To enable cascading with explicit engines, pass `minResults` explicitly.
  - Cascade candidates are now strictly confined to the requested engines.

#### 3. `fetchWebContent` Tool Upgrades
- **Disk-Level Markdown Page Cache**:
  - Caches extracted and cleaned Markdown (not raw HTML) with deep-copy isolation to eliminate cache pollution.
  - Backed by Node 22 native `node:sqlite` with graceful fallback to partitioned JSON files.
  - Quality gates: only caches responses with non-empty title, ≥ 200 characters, and non-bot-challenge pages.
  - Supports 304 conditional revalidation (`ETag` / `If-None-Match`, `Last-Modified` / `If-Modified-Since`), 24h doc TTL, 10m dynamic TTL, 60s 404 negative cache, and 200MB LRU pruning.
  - Added `cache: 'default' | 'reload'` parameter to force re-fetching.
- **Transparent PDF Parsing**:
  - Integrated `unpdf` optional dependency for transparent PDF text extraction directly in `fetchWebContent`.
  - Supports up to 20MB files and up to 50 pages, labeled with `[page N]` markers.
  - Detects scanned image-only PDFs and throws `pdf_no_text_layer` with actionable instructions.

#### 4. `queryDocs` Low-Confidence Protection & Fallback Chain
- Low-confidence match protection: When Context7 match score is low or Context7 request fails, `queryDocs` automatically activates a fallback chain:
  1. npm registry (`https://registry.npmjs.org/<pkg>`) → extracts repository URL → fetches official README.
  2. PyPI JSON API (`https://pypi.org/pypi/<pkg>/json`) → extracts project URLs → fetches official README.
- Returns structured fields: `source: 'context7' | 'npm' | 'pypi' | 'github-readme'`, `confidence: 'high' | 'medium' | 'low'`, and `warnings`.
- If a non-existent package is requested, it avoids returning unrelated libraries and returns candidates with explicit warnings.

#### 5. `fetchTop` Cache Isolation
- Fixed cache pollution issue: deep copy on read and write ensures injecting `fullContent` for top results does not mutate objects in `SearchTtlCache` or page cache.

#### 6. Observability & Prometheus Metrics (`/metrics`)
- Added metrics for fetch cache hits/misses and hit rate (`mywebsearch_fetch_cache_hit_rate_percent`).
- Added timeRange query count and fallback rate (`mywebsearch_timerange_fallback_rate_percent`).
- Added PDF extraction attempts and success rate (`mywebsearch_pdf_success_rate_percent`).
- Added queryDocs query count and fallback rate (`mywebsearch_querydocs_fallback_rate_percent`).
