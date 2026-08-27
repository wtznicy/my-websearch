# MyWebSearch MCP 测评报告

- **被测对象**：`my-websearch` v1.0.9（`io.github.wtznicy/my-websearch`）
- **测评日期**：2026-08-27
- **测评环境**：Windows 11 (10.0.26200) / Node v22.23.1 / Git Bash / 网络代理已开启（境外引擎经代理，国内引擎直连）
- **测评方式**：通过 MCP 客户端实时调用 7 个工具 + CLI/daemon 实测 + 项目自带测试套件，全部为真实网络请求

---

## 一、测评结论（TL;DR）

**综合评分：9.0 / 10。** 代理环境下 9 个搜索引擎全部可用，7 个 MCP 工具在 30+ 项实测中无一功能性缺陷；免 API Key（exa 可选）、SSRF 防护、分页闭环、缓存加速等设计完整；错误信息可操作性高。扣分点集中在个别引擎的结果质量（csdn/juejin）与少量体验瑕疵，均不影响核心功能。

| 维度 | 得分 | 说明 |
|------|:---:|------|
| 功能完整性 | 9.5 | 7 工具/9 引擎全部实测通过，融合、级联、分页、缓存均有实现 |
| 可用性/稳定性 | 9.0 | 30+ 次真实调用零功能性失败；单次瞬时网络抖动后被快速失败机制正确消化 |
| 搜索结果质量 | 8.5 | bing/baidu/sogou/境外引擎相关性好；csdn 混入下载页、juejin 偶有不相关结果 |
| 错误处理 | 9.0 | 参数校验、域名白名单、快速失败+中文指引均到位；一处 Hint 与场景不符 |
| 安全性 | 9.0 | 私网地址拦截、域名白名单、可审计（SECURITY_AUDIT）实测有效 |
| 性能 | 8.5 | 单引擎 1.5–3.5s；daemon 缓存命中 ~9 倍提速；49 项单测 3.1s 通过 |
| 文档 | 9.5 | 双语 README、环境变量表、已知限制透明（如 brave 限流、exa 需 key） |

---

## 二、功能实测明细

### 2.1 search：9 引擎单引擎测试（查询词：`MCP Model Context Protocol 是什么`，limit=3）

| 引擎 | 网络路径 | 结果 | 质量评价 |
|------|------|:---:|------|
| bing | 直连 | 3/3 | 相关性佳，知乎/CSDN 权威科普居前 |
| baidu | 直连 | 3/3 | 相关性佳，含高校官网与官方博客 |
| sogou | 直连 | 3/3 | 相关性佳，含站长站/博客园/公众号源 |
| csdn | 直连 | 3/3 | ⚠️ 前 2 条为 download.csdn.net 下载资源页，其中 1 条 `description` 为空 |
| juejin | 直连 | 3/3 | ⚠️ 前 2 条高度相关，第 3 条为不相关的 Swift 崩溃分析文章 |
| duckduckgo | 代理 | 3/3 | 相关性佳 |
| startpage | 代理 | 3/3 | 相关性佳，含 Google Cloud 官方指南 |
| brave | 代理 | 3/3 | 相关性佳，含 modelcontextprotocol.io 官方文档 |
| exa | 代理 | 3/3 | 相关性佳（Google Cloud/维基百科/官方中文镜像）；`description` 为整段正文，信息量大但 token 消耗偏高 |

**多引擎融合**（`engines: ["bing","duckduckgo","baidu"]`，limit=6）：返回 6 条，三引擎结果交错融合、无重复，字段结构（title/url/description/source/engine）跨引擎完全统一，`partialFailures` 字段就绪。✅

**minResults 级联**：`engines:["duckduckgo"], minResults:8` 时正常返回 10 条（引擎健康时级联不触发）；无代理直连 duckduckgo 失败时，7 秒内快速失败并返回中文指引"引擎暂不可用，可换用其他引擎或稍后重试"，与 README 描述的探测机制（3s 超时 + 重试 1 次 + 结果缓存 5 分钟）一致。✅

### 2.2 fetchWebContent

| 场景 | 输入 | 结果 |
|------|------|------|
| 普通网页正文提取 | `https://example.com` | ✅ readability 提取，返回 title/content/retrievalMethod 等元数据 |
| Markdown 原样抓取 | git 仓库 README.md | ✅ `raw:true` 时 content 与 raw 字段一致，Markdown 语法保留 |
| 截断 + 分页闭环 | 同上，`maxChars:1000` | ✅ `truncated:true`、`hasMore:true`、`nextStartIndex:1000`，尾部附 `[truncated; continue with startIndex=1000]` |
| 分页续读 | 同上，`startIndex:3000` | ✅ 精确从 3000 处续读，`totalLength:3807` 供判断剩余量 |
| 中文大页面 | 汽车之家首页 | ✅ 7320 字符全中文无乱码；GBK/GB2312/GB18030 解码路径存在于 `src/engines/web/fetchWebContent.ts:312`（本次被测站点已改 UTF-8，GBK 路径由源码与单测覆盖佐证） |
| 404 | 不存在的仓库页 | ✅ 报错含状态码；⚠️ Hint 固定为"可降低 maxChars 或分页"，与 404 场景不符（见问题清单） |
| SSRF 防护 | `http://127.0.0.1:3211/mcp` | ✅ 被 zod 校验拦截："private/local network targets are blocked" |

### 2.3 fetchGithubReadme

- `https://github.com/microsoft/vscode` → ✅ 完整 README（约 5K 字符，Markdown 完整）
- `https://gitee.com/wtznicy/my-websearch` → ✅ 走 Gitee 官方 API，中文 README 完整返回，无需代理
- 不存在的仓库 → ✅ 明确的 404 报错（与 README 描述的 raw 直连探测/jsDelivr 兜底分流逻辑一致）

### 2.4 fetchCsdnArticle / fetchJuejinArticle

- 真实 CSDN 文章（约 5500 字）→ ✅ 全文干净提取，无广告/推荐位噪声
- 真实掘金文章 → ✅ 全文提取，结构与原文一致
- 域名白名单：向 `fetchCsdnArticle` 传掘金 URL、向 `fetchJuejinArticle` 传仿冒域名 `fake-juejin.cn` → ✅ 均被明确拦截并说明合法格式（`blog.csdn.net` + `/article/details/`、`juejin.cn` + `/post/`）

### 2.5 context7 融合（resolveLibraryId / queryDocs）

- `resolveLibraryId("express")` → ✅ 返回 5 个候选库 ID，含 `trustScore`（9–10）、`benchmarkScore`、`totalSnippets`、`versions` 等信誉评分，可直接用于择优
- `queryDocs("/expressjs/express", "error handling middleware")` → ✅ 3 段代码示例 + 2 段说明，均带 GitHub 源链接，四参数签名等关键细节准确

### 2.6 参数校验

| 非法输入 | 服务端行为 |
|------|------|
| `engines:["notexist"]` | ✅ 枚举错误并列出全部 9 个合法值 |
| `limit:0` | ✅ 拒绝（最小 1） |
| `maxChars:300` | ✅ 拒绝（最小 1000） |

### 2.7 daemon 与 HTTP API

- `GET /health` → ✅ 结构化状态返回
- `POST /search` → ✅ 正常
- `POST /cache/clear` → ✅ 返回 `cleared:true, cacheSize:0`
- `POST /fetch-web`（海外站、无代理）→ ✅ 结构化错误 `network_error`，附 IPv6/IPv4 多地址诊断明细（信息偏底层，但可定位）

---

## 三、性能实测

| 场景 | 耗时 | 备注 |
|------|:---:|------|
| CLI 单引擎 bing（limit 5） | 1.53s | 直连 |
| CLI 单引擎 baidu（limit 5） | 3.46s | 直连 |
| CLI 双引擎 bing+baidu（limit 5） | 3.05s | 引擎并行，多引擎几乎不增加总耗时 |
| CLI 无代理直连 duckduckgo（失败路径） | 7.05s | 快速失败而非挂满超时（3s 探测 + 1 次重试） |
| daemon 冷查询（bing） | 0.50s | |
| daemon 缓存命中（同 query） | 0.056s | **约 9 倍提速**，验证 5 分钟 TTL 缓存 |
| vitest 单元测试 | 3.12s | **49/49 全部通过**（10 个测试文件） |

> 注：CLI 每次为独立进程，进程内缓存不跨调用；持久缓存收益需 daemon/MCP 常驻模式——实测与设计一致。MCP 工具调用体感均在数秒内，无超时风险。

---

## 四、问题清单

按影响程度排序（本次未发现任何功能性缺陷）：

1. **【低】fetchWebContent 的 404 Hint 与场景不符**：HTTP 4xx/5xx 错误也附带"可降低 maxChars，或用 startIndex 分页继续读取长文档"的中文 Hint，对 404 用户有误导性。建议按错误类型区分 Hint（网络错误/状态码错误给对应指引）。
2. **【低】csdn 引擎结果质量**：前 2 条混入 `download.csdn.net` 下载资源页（正文价值低），1 条 `description` 为空。建议过滤下载类结果或在排序上降权。
3. **【低】juejin 引擎相关性**：第 3 条返回完全不相关的 Swift 文章。站内搜索的相关性上限，建议与其他引擎组合使用。
4. **【低】Windows GBK 控制台下 CLI 中文乱码**：JSON 输出为 UTF-8，在默认代码页的 cmd/部分终端中显示乱码（重定向到文件正常）。属显示层问题，建议 README 提示 `chcp 65001` 或输出前探测控制台代码页。
5. **【观察】字段格式跨引擎不完全一致**：brave 的 `source` 含面包屑路径（`cloud.google.com › discover › ...`），其他引擎为纯域名；exa 的 `description` 为整段正文（数百字），token 成本显著高于其他引擎的摘要。建议统一 source 为纯域名、对超长 description 做截断。
6. **【观察】exa 依赖 `EXA_API_KEY`**：README 已如实说明（其余 8 引擎免 key），未配置时快速失败并附配置指引，无静默空结果。本次实测环境已配置、工作正常。

---

## 五、亮点

1. **免 API Key 生态**：9 引擎中 8 个开箱即用，在"搜索 MCP 普遍要付费 API"的背景下实用价值突出。
2. **工程化的容错设计**：minResults 级联、partialFailures 半失败不阻塞、引擎可达性探测快速失败（7s 而非挂满超时）、Bing 指纹模拟 + Playwright 兜底、缓存手动清空——多层防御环环相扣，且都被实测验证。
3. **安全意识完整**：SSRF 私网拦截、按工具的域名白名单、可选 TLS 白名单与安全审计日志（`SECURITY_AUDIT`）、redirect 安全校验（有专项单测）。
4. **长文档分页闭环**：`truncated/hasMore/nextStartIndex` 三字段 + 尾部提示，Agent 可无人值守地读完超长文档。
5. **错误信息质量高**：中英双语、可操作（"换用其他引擎（engines 参数）或稍后重试"），参数错误直接列出合法枚举值。
6. **文档与透明度**：环境变量全表、已知限制（brave 429、Bing 反爬、大陆网络要求）全部写明，双 README 同步维护，测试资产丰富（49 单测 + 20 余个专项 live 测试脚本）。

---

## 六、改进建议（优先级排序）

1. 按错误类型区分 `fetchWebContent` 的 Hint（404/5xx/超时/网络不可达各给对应指引）。
2. csdn 引擎过滤或降权 `download.csdn.net` 资源页；对空 `description` 结果做剔除或回填。
3. 统一 `source` 字段为纯域名；对超过 ~300 字的 `description` 截断（可加参数控制）。
4. README 增加Windows 控制台中文乱码的说明（`chcp 65001`）。
5. 可选：`search` 返回体中附各引擎耗时，便于 Agent 端动态选择引擎。

---

## 七、测试环境与复现方式

- MCP 工具调用：ZCode 客户端直连本地构建的 stdio server（代理经 env 配置）
- CLI 计时：`node build/index.js search "<query>" --engines <e> --limit 5 --json`（Git Bash `time`）
- daemon：`node build/index.js serve --port 3399` + `curl` 计时
- 单元测试：`npx vitest run`（49/49 通过，3.12s）
