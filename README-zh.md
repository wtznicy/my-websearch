<div align="center">

# 🔍 MyWebSearch

**免 API Key 的多引擎 AI 联网检索与网页正文提纯引擎**  
*MCP Server · CLI 命令行 · 本地常驻 Daemon · 智能 Agent 协同*

**[🇨🇳 简体中文](./README-zh.md) | [🇺🇸 English](./README.md)**

[![npm version](https://img.shields.io/npm/v/my-websearch?style=flat-square&color=3178c6)](https://www.npmjs.com/package/my-websearch)
[![npm downloads](https://img.shields.io/npm/dm/my-websearch?style=flat-square&color=2ea44f)](https://www.npmjs.com/package/my-websearch)
[![license](https://img.shields.io/npm/l/my-websearch?style=flat-square&color=grey)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/wtznicy/my-websearch?style=flat-square&color=e3b341)](https://github.com/wtznicy/my-websearch)
[![M8ven Live Monitored](https://m8ven.ai/badge/mcp/wtznicy-my-websearch-1nmaw4)](https://m8ven.ai/mcp/wtznicy-my-websearch-1nmaw4)

</div>

---

> **一套服务，四种用法：** 通过 MCP 接入 AI 客户端、用 CLI 执行一次性检索、启动本地常驻 Daemon，或在上线前使用内置诊断工具检查网络与浏览器。

**快速跳转：** [快速接入](#quick-start) · [MCP 工具](#mcp-tools) · [CLI](#cli) · [配置](#configuration) · [诊断](#diagnostics) · [开发测试](#development)

## ✨ 核心特性

`my-websearch` 是专为 AI Agent（Claude Desktop、Cursor、Cherry Studio、Windsurf、Cline、ZCode 等）打造的**全栈联网检索与技术文档基础设施**。开箱即用，具备全引擎自适应路由与高质量正文提纯能力：

- 🌐 **16 大引擎融合与自适应路由**  
  聚合国内直连（**Bing、百度、CSDN、掘金、搜狗**）、海外通用（**DuckDuckGo、Brave、Startpage、Yahoo、Exa、Bing News**）与垂直开发者平台（**GitHub、StackOverflow、Hacker News、arXiv**）。支持中文/英文按语种自动路由（`auto`）、多词并发检索（`queries`）、跨引擎去重排序与 `minResults` 自动级联补位；**DuckDuckGo 不健康时，Yahoo 会从英文替补池自动顶上**。
- ⚡ **现代 Web 协议栈与前端算力求解（零浏览器快车道，必要时浏览器兜底）**  
  基于 `wreq-js` 原生模拟现代浏览器 TLS/HTTP2 协议握手与长效会话机制；内置算法解析 **Startpage Anubis SHA-256 PoW 算力挑战** 与 **DuckDuckGo `d.js` (`isJsaChallenge`) 动态前端挑战**，多数挑战无需拉起浏览器即可在毫秒级解出；真实 URL 快速解析（搜狗跳转页还原、百度 `Location` 直取、Bing Base64 解码）。请求栈按引擎区分：**DuckDuckGo 必须用 wreq 的 Chrome profile 发 GET**（axios POST 会吃 202），而 **Brave 默认走 curl HTTP/1.1**（Windows 为 Schannel；实测 curl 7/10 后才 429，axios 0/10，wreq HTTP/2 429）。当 Brave 的 429 实为反爬挑战页时，引擎会用桌面指纹伪装的无头 CDP 浏览器重试一次并自动点击 Argon2 PoW「验证」按钮（约 4–6s；实测 HTTP 持续 429 期间 8/8 成功）。注意：DuckDuckGo 页面级的 **HTTP 202 anomaly CAPTCHA**（点选图片的人机验证）属于人工验证，**不会**被绕过，统一报 `bot_challenge`；Brave 的挑战是计算型（Argon2 PoW），由页面自身 JavaScript 求解，不是我们去破解。
- 📄 **高纯度 Markdown 正文提纯与特色站点规则**  
  整合 Mozilla Readability 与容器级智能降噪，为**微信公众号**（`#js_content` 深度清洗）、**StackOverflow**（问答主体与采纳答案精准提纯）定制专属净化器，针对 **CSDN 与掘金** 自动走专用提取链路；精准保留文章主标题、代码围栏及 GFM 表格；支持长文无缝分页（`startIndex`），并提供三种省 token 模式：**BM25 相关性排序的 `focus`**、**无需 LLM 的 CSS 选择器 `extract` 结构化 JSON**、**编号 `citations` 引用**。
- 📚 **统一 Context7 官方框架/库文档直查（`queryDocs` 一站式合体）**  
  直接输入技术库名（如 `"next.js"`, `"vue"`）或 Context7 ID，内部自动多候选排序、404 自愈重搜并返回相似替代库，免去额外调用 ID 解析步骤。
- 🐙 **全面升级的 GitHub / Gitee 资源抓取**  
  `fetchGithubContent`（原 `fetchGithubReadme`）同时支持 GitHub 与 Gitee：仓库 README、任意源码单文件（`/blob/...`，支持 `lines`/`#L120-L180` 行号切片）、目录树（`/tree/...`）、Issue / PR 完整讨论、Commit（`/commit/<sha>`）、版本对比（`/compare/a...b`）与 Release（`/releases`、`/releases/tag/<tag>`）。
- 🌏 **零配置网络感知（TUN / Fake-IP 完美适配）**  
  自动嗅探系统代理（Windows 注册表 / macOS scutil / Linux 环境变量），海外引擎走代理、国内引擎直连；原生支持 `198.18.0.0/15` 放行，无缝兼容 TUN / 虚拟网卡，严守内网 SSRF 安全边界。
- 🔌 **全形态接入支持**  
  支持 **MCP STDIO**（Claude/Cursor 极简接入）、**Streamable HTTP / SSE**（Cherry Studio 等远程客户端）、**终端 CLI** 一次性工具，以及**本地常驻 Daemon**（支持连接池复用与 `/metrics` Prometheus 监控）。

---

## 🌍 16 大搜索引擎一览

| 引擎标识 | 网络要求 | API Key | 核心技术与优势 | 最擅长场景 |
| :--- | :---: | :---: | :--- | :--- |
| **`bing`** | 🇨🇳 直连 | 无 | Chrome TLS 指纹 + Base64 真实链接解码 + 隐身兜底 | 综合技术检索、中英文混合查询 |
| **`bing-news`** | 🌐 需代理 | 无 | **Bing News RSS** + `pubDate` 24h 过滤 + `apiclick.aspx?url=` 解码；直连可能 302 到 HTML 页，因此默认走代理；opt-in 垂直引擎 | 突发新闻、24 小时内更新 |
| **`baidu`** | 🇨🇳 直连 | 无 | 并发 `Location` 跳转直取 + 验证拦截状态精准识别 | 中文资讯、本土百科、国内论坛 |
| **`csdn`** | 🇨🇳 直连 | 无 | 自动持久化阿里云 WAF Cookie + 空壳响应智能重试 | 中文报错排查、开发踩坑笔记 |
| **`juejin`** | 🇨🇳 直连 | 无 | 掘金官方接口直调，极速提取干净长文 | 前端/后端现代中文高质量技术博文 |
| **`sogou`** | 🇨🇳 直连 | 无 | 桌面/移动双栈解析 + 跳转页快速还原 + 自动去推广 | 微信公众号外链、中文长尾问答 |
| **`duckduckgo`** | 🌐 需代理 | 无 | **wreq Chrome 指纹 GET HTML 端点**（仅 axios 回退时可能遇到 202 anomaly CAPTCHA）；保留 `d.js` 求解器作为 preload 回退 | 英文技术检索、海外开源讨论 |
| **`startpage`** | 🌐 需代理 | 无 | **多 Worker Anubis SHA-256 PoW 求解器**（难度 ≤ 6）+ 隐私直通 | 谷歌同源高质量检索（隐私高保真） |
| **`yahoo`** | 🌐 需代理 | 无 | SSR HTML + 首页 cookie 预热 + `RU=` 重定向还原；**英文替补池第一顺位**（DuckDuckGo 不健康时自动顶上） | 稳定的 Bing 索引英文兜底 |
| **`brave`** | 🌐 需代理 | 无 | **curl HTTP/1.1**（Windows 为 Schannel；实测 curl 7/10 后才 429；axios 0/10；wreq HTTP/2 429）+ 赞助商商业推广深度剥离；兼容 Windows 旧版 curl（不依赖 `--compressed`）；429 时自动用桌面指纹伪装的无头 CDP 浏览器触发 PoW（约 4–6s，实测 HTTP 持续 429 期间 8/8 成功）；仍不行再等待 / 换节点 / 配 `BRAVE_API_KEY` | 独立海外英文索引、技术博客 |
| **`exa`** | 🌐 建议代理 | 选配 Key | 官方语义搜索 API（未配置时自动跳过，不阻断级联）；直连也可用，但实测代理约 0.77s、直连约 1.17s | 深度语义相似搜索、学术与技术前沿 |
| **`github`** | 🌐 直连 API | 无 | 官方 REST API 检索仓库与 Issue；**精确 owner/repo 直取** | 开源项目源码、开源库 Issues 排查、已知仓库查看 |
| **`stackoverflow`**| 🌐 直连 API | 无 | StackExchange 2.3 官方 API + HTML 实体智能解码 | 编程报错排错、高质量代码问答 |
| **`hackernews`** | 🌐 直连 API | 无 | Algolia HN API，含 points、评论数与作者元信息 | 极客社区讨论、前沿科技热点与观点 |
| **`arxiv`** | 🌐 直连 API | 无 | 官方 Atom XML API 检索论文标题、作者与摘要 | 计算机科学、AI/ML 与自然科学最新论文 |
| **`code`** | 🌐 国内需代理 | 无 | grep.app API 实时检索全球 GitHub 代码，含仓库、文件路径与精确代码行 | 源码实现翻查、API 使用范例、开源语法实战 |

> **版本说明**：本 README 跟随当前源码树（**1.5.1**）。**1.5.1** 是搜索质量版本：早退改为「相关性 + 多样性」双门控、域名打散 Host Cap（单域 ≤2、官方域 ≤3）、中文技术路由改为 Bing/百度/搜狗、实体与标题焦点护栏、官方意图锚点注入（MCP/Vitest/Node.js/Next.js/React/Vue/TypeScript/Docker/PostgreSQL/Zustand）并为 Node.js 版本查询补官方 LTS 页、百度真实 URL 提取、日期型规范版本加权、级联 3.5s 封顶与 CSDN 3.5s 超时、支持 `apiKeys.gitee`、`codeSymbol` 缺 token 快速失败，以及 `npm run eval:quality` 10 场景基准套件。**1.5.0** 统一测试体系（legacy 脚本全部迁入 Vitest，CI 只保留单一 runner）、把所有 `process.env` 读取收敛到 `src/config/env.ts`（ESLint 强制）、拆分四个最大模块、Brave 429 后新增 **180 秒「浏览器优先」窗口**、CLI 服务器栈惰性加载（冷启动约 0.32s）、`doctor --network` 新增缓存命中率 / 熔断剩余 / P50-P95 指标、核心依赖升级（MCP SDK 1.32、axios 1.21、cheerio 1.2、express 5.3、zod 4），并要求 **Node.js ≥22**（Vitest 5 与可选依赖 `unpdf` PDF 解析均要求；`node:sqlite` 可用时优先使用，否则回退分片 JSON），同时新增 Node 22 的 Windows CI job。此前：**1.4.2** 新增 Brave 429 挑战分类与伪装 CDP 浏览器回退；**1.4.1** 修复 Windows 旧版 curl 兼容；**1.4.0** 新增 `codeSymbol`、CDP 设备 profile 与 DDG 202 回退；npm latest 可能滞后到包发布完成。

---

<a id="mcp-tools"></a>

## 🛠️ 5 大核心 MCP 工具（极简高效，低 Token 消耗）

> 💡 **Token 预算与瘦身**：所有工具描述均严格控制在 250 字符以内（总描述字符 ≤ 1200），更详细的路由策略已移入 `McpServer({ instructions })`，大幅降低宿主 LLM 的 Context 开销。

| 工具名称 | 功能定位 | 关键特性 |
| :--- | :--- | :--- |
| **`search`** | 16 大引擎联合联网与代码检索 | 支持多词并发、`timeRange: day\|week\|month\|year` 时间过滤、`site: string[]` 域名过滤，以及 `site:`、`filetype:`、`after:`、`before:`、`-排除词` 查询语法的跨引擎转译与本地后置过滤；`fetchTop` 正文前瞻、`code` 代码引擎（grep.app）；显式传 `engines` 默认 `minResults=0` 且仅在候选内级联；失败附带网络内联诊断（`diagnostics: { proxy, dns, suggestion }`） |
| **`fetchWebContent`** | 通用网页正文、Markdown 与透明 PDF 提取 | **全能知识提取网关**：内置磁盘级 Markdown 缓存（Node 22 `node:sqlite` / 分片 JSON 兜底，200MB LRU，`cache: default\|reload` 强制刷新）；透明解析 PDF（上限 20MB / 50 页，带 `[page N]` 标记，纯扫描版明确报错）；统一分页与 `focus` 章节定位（默认 **`bm25`** 按段落相关性选块，`window` 保留旧的固定窗口）；**`selector`** 用 CSS 选择器收窄提取范围（未命中直接报错，不静默回退全页）；**`extract`** 用 CSS schema 直接产出结构化 JSON（无需 LLM）；**`citations`** 把正文链接改写成编号引用 + 末尾 References；**`retainLinks`** 裁剪 URL（列表页实测省 50%） |
| **`fetchGithubContent`** | 全能 GitHub / Gitee 内容提取网关 | 提取 README、**单个源码文件**（`/blob/<ref>/<path>`，支持 `lines`/`#L120-L180` 切片，上限 400 行）、目录树（`/tree/`，自动过滤 lock/build 产物）、Issue 与 PR、Commit（`/commit/<sha>`）、Compare（`/compare/a...b`，patch 限长 + lockfile 过滤）、Release（`/releases[/tag/<tag>]`，`releaseLimit` 1–30）；`ref` 可为分支/tag/commit；Gitee 已对齐（可选 `GITEE_TOKEN`）；返回 `warnings` |
| **`queryDocs`** | 一站式开源框架/库官方文档 | 支持库名或 Context7 ID；可选 **`source`** 多源文档选择（`auto`, `official`, `docs.rs`, `pkg.go.dev`, `context7`, `npm`, `pypi`）；可选 **`version`** 钉定版本；**24h 本地缓存**（`cache: reload` 强制刷新）；自动直连官方文档站与生态源，或通过 npm / PyPI / crates.io / Go / Maven 仓库兜底；返回 `source`、`confidence` 与 `warnings` |
| **`codeSymbol`** | 远程 GitHub 符号查询 | GitHub Code Search + raw/CDN 文件；可选 Tree-sitter AST（后台下载并缓存 grammar，冷启动回退扫描器，一次解析同时产出定义与调用点）；多行签名、Python 装饰器、词法级括号匹配、过滤后的调用点、re-export + monorepo tsconfig `extends`/paths；TypeScript/JavaScript 走 TS checker，Python/Go/Rust 提供注解级类型；symbol/content/analysis TTL 缓存 + 软预算 partial 返回；私有仓库走 Contents API；需要 `GITHUB_TOKEN`；未拉取的 import 会退化为 `any` |

> 💡 **向后兼容说明**：原独立的 `fetchCsdnArticle` 与 `fetchJuejinArticle` 已平滑下沉并收口进通用的 `fetchWebContent`（按域名自动采用最佳专有提取引擎）；原 `resolveLibraryId` 已合并入 `queryDocs`（支持直接传 `library` 库名或旧版 `libraryId` 别名自动解析定位）。独立的 legacy 工具已移除 —— `REGISTER_LEGACY_ARTICLE_TOOLS` 开关一并删除，因为保留三个永不注册的 handler 依然要占工具描述预算。

> 🧩 **MCP Prompts**：已注册 `deep-research`（多源研究 + 引用）与 `code-lookup`（官方文档 + 源码 + Release Notes）两个服务端 Prompt 模板，支持 MCP Prompts 的客户端可直接调用。

> 🗂️ **MCP Resources**：只读的 `websearch://cache/pages` / `websearch://cache/docs` 索引与单条 Markdown 资源，直接读取已缓存内容，不额外消耗工具调用，也不会触发新的网络抓取。

---

<a id="quick-start"></a>

## 🚀 快速接入

### 1. NPX 一键运行（零配置）

无需安装，开箱即用：

```bash
npx -y my-websearch@latest
```

> 💡 **全自动网络感知**：项目默认自动探测操作系统的系统代理。只要本地开启了网络代理环境，国际引擎自动走代理通道，国内引擎自动走高速直连；Fake-IP（`198.18.0.0/15`）已内置放行。

### 2. 主流 AI 客户端配置

#### 🔹 自动配置（推荐）

`init` 会自动探测本机已安装的 MCP 客户端，把服务器条目写进它们的配置文件，并保留 `.bak` 备份：

```bash
npx -y my-websearch@latest init                      # 自动探测并写入
npx -y my-websearch@latest init --dry-run            # 只打印 diff，不落盘
npx -y my-websearch@latest init --client cursor,code # 指定客户端
```

开箱支持 **Claude Desktop**、**Cursor** 和 **VS Code**（工作区级 `.vscode/mcp.json`）。已有条目默认**不会覆盖**（需要 `--force`），配置文件不是合法 JSON 时直接拒绝修改，Windows 下会自动写入 `cmd /c npx`。重启客户端后可用 `my-websearch doctor` 验证。

#### 🔹 手动配置

**Claude Desktop / Cursor / Windsurf / Cline (STDIO 极简模式)**

在对应客户端的 MCP 配置文件中加入：

```json
{
  "mcpServers": {
    "my-websearch": {
      "command": "npx",
      "args": ["-y", "my-websearch@latest"],
      "env": {
        "MODE": "stdio"
      }
    }
  }
}
```

*(Windows 环境：`init` 已自动处理。手动配置时若 `npx` 不在系统 PATH 中，可将 `command` 设为 `cmd`，`args` 设为 `["/c", "npx", "-y", "my-websearch@latest"]`)*

#### 🔹 Cherry Studio (Streamable HTTP 模式)

在终端运行 `npx my-websearch@latest`（默认端口 `3211`），并在 Cherry Studio 中配置：

```json
{
  "mcpServers": {
    "web-search": {
      "name": "MyWebSearch",
      "type": "streamableHttp",
      "baseUrl": "http://localhost:3211/mcp"
    }
  }
}
```

---

<a id="cli"></a>

## 💻 CLI 命令行与常驻 Daemon

`my-websearch` 可直接在终端作为 CLI 工具或本地常驻 Daemon 运行。自动化场景建议统一使用 `--json`，除非明确需要远程访问，否则请保持服务监听在 `127.0.0.1`：

```bash
# 全局安装
npm install -g my-websearch

# 自动探测已安装的 MCP 客户端并写入配置（--dry-run 仅预览）
my-websearch init

# 启动本地常驻 Daemon（复用底层连接池与缓存，默认端口 3210）
my-websearch serve

# 终端一次性搜索（自动复用运行中的 Daemon）
my-websearch search "Model Context Protocol 最佳实践" --limit 5 --min-results 5 --json

# 只看最近一周发布的结果（day|week|month|year）
my-websearch search "typescript 5.9 release" --time-range week --json

# 提取网页正文为纯净 Markdown
my-websearch fetch-web "https://blog.vuejs.org/posts/vue-3-5" --max-chars 15000 --json

# 查看 Daemon 状态与 Prometheus 指标（/health, /status, /metrics）
my-websearch status --json

# 清空内存搜索缓存
my-websearch cache-clear
```

---

<a id="diagnostics"></a>

## 🩺 诊断与排障

遇到代理、浏览器或引擎问题时，先使用内置 doctor：

```bash
# 检查本地配置与浏览器（只查路径；要验证能否真正启动请加 --browser）
my-websearch doctor

# 验证 Chromium 系浏览器能否真正启动（自动探测 / CHROME_PATH / PLAYWRIGHT_CDP_ENDPOINT）
my-websearch doctor --browser

# 执行真实代理/引擎探测（会访问上游服务）
my-websearch doctor --network

# 只探测指定引擎，并输出 JSON
my-websearch doctor --network --engine bing,duckduckgo --json

# 重置并清除引擎熔断与健康状态缓存
my-websearch doctor --reset-health
```

报告会区分配置状态、代理 TCP 连通性、HTTP 连通性、应用层解析、浏览器启动和交互验证状态。对 Brave，429 还会进一步区分为 `captcha`（人机验证，重试通常仍被拦）或 `quota`（配额/频控窗口）：文本报告显示为 `challenge=...`，`--json` 里是 `challengeKind`。网络模式还会汇总缓存命中率（搜索缓存与抓取页缓存）、各引擎熔断剩余时间，以及存在持久化样本时的引擎 P50/P95 耗时。网络模式会发起真实请求，不建议高频执行。

### 🌐 代理排障与上游频控辨析

在配置或调试代理时，如果遇到异常表现，请对照以下高频排查点：

1. **启动日志显示 `🌐 Proxy: disabled`，但明明配置了 `proxy.url`？**
   - **排查 `useProxy` 字段**：在 `~/.my-websearch/config.json` 中，若配置了 `"useProxy": false`，根据配置优先级规则，该参数会**显式覆盖并强制禁用 `url`**（产生 `PROXY_URL='false'`），导致代理被静默关闭。请将 `"useProxy"` 改为 `true` 或直接删除该字段（只要存在有效 `url` 即可自动启用代理）。
   - **系统代理会自动检测**：未显式配置代理时，程序会读取系统代理（Windows 注册表 / macOS `scutil` / `HTTPS_PROXY`）并用于海外引擎和通用抓取——只要代理软件开着「系统代理」就不必再配 `PROXY_URL`；只有检测失败或需要固定某个代理时才显式设置。
   - **优先写 `~/.my-websearch/config.json`，不要写客户端 `env`**：把 `proxy.url` 和 API key 放进配置文件。部分 MCP 客户端（如 WorkBuddy）用 `command + args + env 键名集合 + cwd` 计算信任指纹，加一个 `PROXY_URL` 环境变量会改变指纹，服务器可能静默掉线；配置文件在启动时读取，不受影响。
   - **代理到底写哪里**（旧报错只说 "MCP client config"，确实有歧义）：
     | 位置 | 适用场景 |
     | :--- | :--- |
     | `~/.my-websearch/config.json` → `"proxy": { "url": "http://127.0.0.1:7897" }` | **推荐**。所有客户端（CLI/daemon/MCP）统一生效，且不改变客户端信任指纹。 |
     | MCP 客户端 `env` → `PROXY_URL` | 单客户端覆盖；需重启客户端，部分客户端会把 env 键名计入信任指纹。 |
     | 代理软件的「系统代理」开关 | 完全不用配置。**1.3.8 起**会自动检测并用于海外引擎和通用抓取。 |

2. **配置了有效代理后，国际引擎依然失败或超时？（逐引擎诊断，不是本地配置错误）**
   - **DuckDuckGo 返回 HTTP 202 / 验证挑战**：202 响应体是 DDG 的 **anomaly CAPTCHA（人工验证页）**，不是普通按 IP 限流；内置 `d.js` 算术求解器无法绕过。引擎会先用 **wreq Chrome 指纹 GET** 请求 HTML 端点——即使 axios POST 路径吃 202，这条路径通常也能返回 200；所以现在只有 wreq 路径失败、回退到 axios POST 时才会再见到 202。如果仍看到 202，先确认你的版本包含 wreq GET 路径（**1.3.8 及更早没有**），再重试或检查代理是否真的挂上。**DDG 仍是 best-effort**：同一出口也可能间歇性被挑战，不要把它当 SLA；要稳定请用 Bing/Startpage 或配置 `BRAVE_API_KEY`/`EXA_API_KEY`。注意：`SEARCH_MODE=playwright:duckduckgo` 不受支持（DDG 没有浏览器渲染路径），会回退到 HTTP。
   - **Bing 返回 HTTP 200 但 0 条结果**：wreq 协议路径解析为空时会自动回退到 axios 网页路径；若两条路径都为空，通常是查询词或 IP 受到频控策略限制。
   - **Brave 返回 HTTP 429 (Too Many Requests)**：请求若干次后，CloudFront 边缘会对该出口 IP 下发人机挑战页（HTTP 429）；而最初几次请求是否成功，很大程度取决于客户端 TLS/HTTP 栈。新节点实测：**axios（Node OpenSSL，HTTP/1.1）→ 0/10，全 429**；**curl（Schannel，HTTP/1.1）→ 7/10，随后 3/3 429**；**wreq（HTTP/2 Chrome）→ 429**；**.NET Schannel HTTP/2 → 200/429 混合**。curl 触发 429 后，再用 .NET Schannel HTTP/2 重试：同 URL **0/3**，新 URL **0/3**——额度耗尽后换客户端栈无效。现在 Brave 网页路径固定用 curl（Windows 为 Schannel，不再回退 axios），触发条件是**滚动 60 秒窗口内累计 6 个请求**——第 7 个请求会被挑战（干净出口实测：每 10 秒 1 次，前 6 次 200、第 7 次 429）。这里的 429 不是普通配额页：响应体是 Brave 的 SPA 人机挑战（captcha + Argon2 `challengeSet`），因此上报为 `bot_challenge` 而不是 `rate_limited`。恢复跟着窗口走、不是固定计时器：等突发里最早的请求滑出 60 秒后才会重新放行（实测 7 个请求挤在 10 秒内 → 62.9 秒恢复；同样 6 个请求摊在 52 秒内 → 约 15 秒就恢复）。**在窗口内重试会继续往窗口里补请求、反而延长封禁**——每 15 秒 / 30 秒探一次，实测分别拖到 255 秒 / 6.5 分钟仍 429。因此引擎对 Brave 的首档熔断设为 **60 秒**（之后 120 → 240 → 300 秒），并先用一次桌面指纹伪装的无头 CDP 浏览器兜底、自动点击 PoW「验证」按钮（硬封禁出口上 8/8 成功，每次约 4–6 秒）。这个兜底**只服务当次搜索，不会解开 HTTP 窗口**：浏览器通过后，接下来的 HTTP 请求只成功 1 次就又 429。换客户端栈同样无效（axios 0/10；wreq HTTP/2 429；curl Schannel HTTP/1.1 在窗口触发前 7/10）。稳定路径仍是官方 API（`BRAVE_API_KEY`）。`BRAVE_BROWSER_FALLBACK=0` 会同时关闭兜底和这个窗口。命中 429 后引擎进入 **180 秒「浏览器优先」窗口**（仅长驻的 MCP/daemon 进程；CLI 一次性命令每次都是新进程）：完全跳过 HTTP，所有 Brave 调用直接走伪装浏览器（不再用 curl 白撞、继续延长服务端窗口）；窗口内的引擎仍算可用，但会被 auto 路由和级联**排到最后**，避免拖慢正常搜索；若浏览器也失败则触发熔断（60 → 120 → 240 → 300 秒），由路由/级联换引擎。
   - **Startpage 请求挂满超时或 Anubis PoW 难度过大**：难度 6 现由最多 4 个 Worker 并行求解（约 3–12s）；难度 >6 会自动跳过；pass-challenge 的 socket 错误/瞬时 5xx 会自动重试。
   - 💡 **解决方案**：这些是上游反爬/频控行为，不是 MCP 配置坏了。按引擎分别处理：DDG 202 → 升级/重试（wreq GET 路径；`auto` 模式下 Yahoo 也会从替补池顶替不健康的 DDG）；Brave 429 → 先由桌面指纹浏览器回退兜底（见上），仍失败再等窗口过去、换出口 IP 或配 `BRAVE_API_KEY`；Bing 0 条 → 重试或换查询词；Startpage PoW → 重试。只有引擎特定的步骤都无效时再换出口 IP。最后才用 `engines: ["bing", "baidu"]` 降级，或配置官方 Key（`BRAVE_API_KEY` / `EXA_API_KEY`）走 SLA 通道。

<a id="configuration"></a>

## ⚙️ 配置中心与环境变量

### 统一配置文件（`~/.my-websearch/config.json`）

为避免在不同 MCP 客户端中反复声明参数，支持全局统一配置：

```json
{
  "apiKeys": {
    "context7": "ctx7sk-...",
    "exa": "...",
    "github": "ghp_...",
    "gitee": "...",
    "brave": "..."
  },
  "proxy": {
    "url": "http://127.0.0.1:7897",
    "useProxy": true,
    "engines": ["duckduckgo", "exa", "brave", "startpage"]
  }
}
```

> ⚠️ **关于 `useProxy` 的重要说明**：只要配置了 `"url"`，代理默认就会自动启用。如果显式配置了 `"useProxy": false`，会**强制覆盖并废掉 `url`**。因此若要启用代理，请将该字段设为 `true` 或直接省略不写。
> **Key 与重启**：`apiKeys` 下的条目会在启动时映射为环境变量（`github` → `GITHUB_TOKEN`、`gitee` → `GITEE_TOKEN`、`context7` → `CONTEXT7_API_KEY`…），且只填补**客户端 env 中尚未设置**的变量。改完文件需重启 MCP server；`my-websearch doctor` 会显示当前实际可见的 key。

### 📋 环境变量完整全量参考

支持通过全局配置文件（`~/.my-websearch/config.json`）、本地 `.env` 或系统环境变量设置：

#### 0. 🖥️ 服务器与运行时

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `HOST` | `127.0.0.1` | MCP HTTP 监听地址；绑定到非回环地址时会自动加入 Host 白名单并打印无鉴权警告 |
| `OPEN_WEBSEARCH_DAEMON_HOST` / `OPEN_WEBSEARCH_DAEMON_PORT` | `127.0.0.1` / `3210` | 本地 REST daemon 监听地址（无鉴权，保持回环） |
| `METRICS_ENABLED` | `false` | 启用进程内计数器与 daemon `/metrics` 端点 |
| `FETCH_WEB_DEADLINE_MS` | `45000` | 单次 `fetchWebContent` 的硬截止时间（cookie + 浏览器 + 重试合计） |
| `BING_BROWSER_BUDGET_MS` / `BING_PLAYWRIGHT_BUDGET_MS` | `6000` | Bing 浏览器兜底预算（由 raw CDP 驱动），超时后保留 HTTP 结果；兼容旧变量名 `BING_PLAYWRIGHT_BUDGET_MS` |
| `MYWEBSEARCH_NO_AUTO_BOOTSTRAP` | 未设置 | 设为 `1` 时，首次运行不再从其他应用的 MCP 配置中复制 API Key |

#### 1. 🔍 检索与路由编排

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `DEFAULT_SEARCH_ENGINE` | `auto` | 默认搜索引擎。`auto`（智能感知路由：中文走 `baidu,sogou`，英文走 `bing,duckduckgo`）。支持全部 16 个引擎：`auto`、`bing`、`bing-news`、`baidu`、`sogou`、`duckduckgo`、`brave`、`csdn`、`juejin`、`startpage`、`yahoo`、`exa`、`github`、`stackoverflow`、`hackernews`、`arxiv`、`code`（垂直开发者引擎可配置为默认，全局默认推荐保持 `auto` 或通用网页引擎） |
| `ALLOWED_SEARCH_ENGINES` | 全部 | 限制启用的引擎白名单（逗号分隔，如 `bing,baidu,duckduckgo`） |
| `BING_BASE_URL` | `https://cn.bing.com/search` | Bing 搜索请求基址。国际用户可改为 `https://www.bing.com/search` 或自定义中转域名 |
| `DEFAULT_MIN_RESULTS` | `5` | 级联补位阈值：可用结果数不足该值时，自动调度备用引擎补齐 |
| `DEFAULT_SEARCH_LIMIT` | `10` | 工具调用未显式传 `limit` 时的单次返回上限（最大 50） |
| `SEARCH_DEADLINE_MS` | `30000` | 搜索任务全局超时硬预算（毫秒） |
| `SEARCH_FUSION` | `legacy` | 结果融合模式：`legacy`（命中引擎数 + 到达顺序）或 `rrf`（按各引擎内排名做 Reciprocal Rank Fusion，并在重排阶段替换 position/consensus 两项）。RRF 默认关闭，等待更大评测集。 |
| `SEARCH_FUSION_RRF_K` | `20` | RRF 常数 k，越小越放大排名差异；仅 `SEARCH_FUSION=rrf` 时生效。 |
| `GITHUB_CONTENT_CDN_FIRST` | `false` | README 与源码文件优先走 jsDelivr（仅公开仓库）；旧名 `GITHUB_README_CDN_FIRST` 仍兼容。 |
| `GITHUB_CONTENT_BUDGET_MS` | `12000`（CDN-first 时 `6000`） | 单次 `fetchGithubContent` 的总时间预算；单次尝试上限 4.5s。 |
| `ENGINE_CIRCUIT_BASE_COOLDOWN_MS` | `30000` | 引擎首次熔断冷却（429 / 202 / 验证状态）。连续失败指数退避（30s → 60s → 120s…）。Brave 的首档被覆盖为 **60s**（其 429 是「滚动 60 秒内 6 个请求」的窗口，第 7 个触发，且要等最早请求滑出窗口才恢复）；显式设置该变量会关闭按引擎覆盖。 |
| `SEARCH_AUTHORITY_DOMAINS` | 空 | 结果重排的额外权威域名白名单（逗号分隔，追加到内置白名单） |
| `SEARCH_MODE` | `auto` | 检索模式与浏览器启动策略。支持单模式、一种方式多选引擎、以及多启动方式组合：<br/>• **全局模式**：`auto`（默认允许兜底）、`request`/`none`（全纯HTTP防爆内存）、`browser`/`playwright`（全强走CDP浏览器）<br/>• **一种方式多选引擎**：`browser:bing,startpage`、`auto:bing,startpage`、`bing,startpage`<br/>• **多选启动方式组合**：`browser:bing;auto:startpage`（bing强走渲染，startpage走自动兜底）、`auto;request:startpage`（全局auto但startpage走纯HTTP） |
| `BRAVE_BROWSER_FALLBACK` | `1` | Brave 无 Key 网页路径返回 HTTP 429 / 人机挑战时，是否用桌面指纹伪装的无头 CDP 浏览器重试一次，并自动点击 Argon2 PoW「验证」按钮（`1` 启用，`0` 关闭并快速失败）。命中 429 后会打开 **180 秒的「浏览器优先」窗口**：窗口内跳过 HTTP、所有 Brave 调用直接走浏览器；若浏览器也失败则升级为熔断（60 → 120 → 240 → 300 秒），由路由/级联换引擎。实测在 HTTP 持续 429 期间 8/8 成功、每次约 4–6s。仍是 best-effort：无法通过交互式滑块验证 |
| `AUTO_ROUTE_EN_ENGINES` | `bing,duckduckgo` | 英文查询默认自动路由引擎列表（逗号分隔） |
| `AUTO_ROUTE_ZH_ENGINES` | `baidu,sogou` | 中文查询默认自动路由引擎列表（逗号分隔） |

#### 2. 🌐 代理与网络安全

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `PROXY_URL` | 空（关闭） | 统一上游代理配置（已合并原 `USE_PROXY` 与 `PROXY_ENGINES`，TUN 模式无需配置保持直连）。<br/>• **开启默认代理**：传空值 `PROXY_URL=""` 或 `PROXY_URL=true` 即可启用默认 `http://127.0.0.1:7897`（常见本地代理端口如 7897、7890、10809；默认仅国际引擎走代理，国内引擎直连）<br/>• **自定义地址**：`PROXY_URL=http://127.0.0.1:10809`<br/>• **自选引擎**：`PROXY_URL="http://127.0.0.1:7897;duckduckgo,brave"` 或全部引擎走代理 `PROXY_URL=";all"` |
| `FAKE_IP_CIDRS` | `198.18.0.0/15` | Fake-IP 虚拟网段白名单，避免误触发 SSRF 本地私网地址拦截 |
| `CUSTOM_DNS_SERVERS` | `223.5.5.5,119.29.29.29,1.1.1.1,8.8.8.8` | 内部 c-ares 解析器使用的 DNS 服务器（逗号分隔），系统 DNS 被污染时可用；会整体替换内置列表 |
| `IMPERSONATE_BROWSER` | `chrome_149` | `wreq-js` 模拟的现代浏览器 TLS/H2 指纹（如 `chrome_149`, `safari_18`） |
| `IMPERSONATE_OS` | `windows` | 指纹模拟使用的操作系统平台（`windows`, `macos`, `linux`） |
| `BING_IMPERSONATE` | `true` | 是否启用 Bing 的 Chrome TLS 指纹模拟（连续多次返回 0 条时会自动熔断降级为标准 HTTP） |
| `FETCH_WEB_INSECURE_TLS` | `false` | 仅对 `fetchWebContent` 关闭 TLS 证书校验（目标站点旧证书链损坏时使用） |

> **自定义代理引擎名单**：如果你在 `~/.my-websearch/config.json` 写了 `proxy.engines`，或用 `PROXY_URL` 的 `;engine1,engine2` 后缀，**`yahoo` 与 `bing-news` 会被自动补齐**——它们在墙内直连不可用（Yahoo 15–20s 超时；Bing News 返回 302/HTML）。仍然推荐直接删掉这份名单：默认名单已包含它们，并把 GitHub / Stack Overflow / Hacker News / arXiv 这些直连 API 引擎排除在代理之外。

#### 3. 🔐 外部服务凭据与 API Key

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `CONTEXT7_API_KEY` | 空 | [Context7 API Key](https://context7.com/dashboard)（强烈推荐 TUN/代理用户配置，免受共享 IP 200次/月限额影响） |
| `EXA_API_KEY` | 空 | [Exa 官方免费 Key](https://dashboard.exa.ai/api-keys)（仅使用 `exa` 语义搜索时需要） |
| `BRAVE_API_KEY` | 空 | [Brave Search API Key](https://api.search.brave.com/app/keys)（选配，配置后优先走官方 API 高可靠检索） |
| `GITHUB_TOKEN` | 空 | [GitHub Personal Access Token](https://github.com/settings/tokens)（选配，提高 GitHub 搜索与内容抓取的速率配额至 5,000次/小时） |
| `GITEE_TOKEN` | 空 | [Gitee Personal Access Token](https://gitee.com/profile/personal_access_tokens)（选配，提高 Gitee API 配额并支持私有仓库）。也可写在 ~/.my-websearch/config.json 的 piKeys.gitee。 |
| `STACKOVERFLOW_API_KEY` | 空 | [Stack Apps Key](https://stackapps.com/apps/oauth/register)（选配，提高 StackOverflow 检索配额至 10,000次/天） |

#### 4. 🖥️ 服务模式、并发与会话治理

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `MODE` | `both` | MCP 传输通道：`stdio`（仅标准输入输出）、`http`（仅网络接口）、`both`（同时开启） |
| `PORT` | `3211` | MCP HTTP/SSE 监听端口（CLI 本地常驻 Daemon 默认使用 `3210`） |
| `MAX_CONCURRENT_SEARCHES` | `20` | Daemon 模式下的全局最大并发搜索数（`0` 表示不限制） |
| `MCP_MAX_SESSIONS` | `100` | 保留的最大并发会话上限，超限时返回 HTTP 429 保护服务器内存 |
| `MCP_SESSION_TTL_MS` | `1800000` | 会话空闲回收时长（默认 30 分钟） |
| `LOG_LEVEL` | `info` | 日志输出级别：`quiet`（完全静默）、`debug`、`info`、`warn`、`error` |
| `SECURITY_AUDIT` | `false` | 是否开启安全审计日志（输出 SSRF 拦截详情与主机头放行记录） |
| `OPEN_WEBSEARCH_ALLOWED_HOSTS` | 本地回环 | HTTP 服务允许的 Host 域名白名单（DNS Rebinding 安全防护，逗号分隔） |

#### 5. 🧭 CDP 浏览器高级控制（保留 Playwright 旧变量名）

> [!NOTE]
> 浏览器兜底走 **raw Chrome DevTools Protocol**（`chrome-remote-interface`），因此只支持 **Chromium 系**浏览器：Chrome、Edge、Chromium、Brave、Vivaldi、Opera（**Firefox / WebKit 不支持**）。以上常见安装路径都会自动探测；也可用 `CHROME_PATH` / `BROWSER_PATH` / `PLAYWRIGHT_EXECUTABLE_PATH` 指定路径，或用 `PLAYWRIGHT_CDP_ENDPOINT` 连远程浏览器（本机无需安装）。`my-websearch doctor --browser` 会报告探测到的浏览器以及缺失时的修复方式。`PLAYWRIGHT_*` 变量名与 `SEARCH_MODE=playwright` 仅为向后兼容保留，底层由 CDP 驱动。

两个**互不相关**的维度，别混在一起：

- **`BROWSER_DRIVER`** 决定用哪套「遥控器」：`cdp`（默认，内置 `chrome-remote-interface`）或 `playwright`（遗留逃生口，需要你自行安装 `playwright-core`）。
- **`PLAYWRIGHT_CDP_ENDPOINT` / `CHROME_PATH` / `BROWSER_PATH` / `PLAYWRIGHT_EXECUTABLE_PATH`** 决定浏览器「从哪来」：连一个已在运行的本地/远程 CDP 端点、指定可执行文件，或交给自动探测。

所有浏览器路径——Bing 兜底、Startpage、DuckDuckGo、Brave、`fetchWebContent`、CSDN 正文抓取、`doctor --browser`——都走同一个入口，所以这些设置对所有场景同时生效。

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `BROWSER_DRIVER` | `cdp` | 浏览器后端：`cdp`（默认，raw CDP）；`playwright` 为旧版逃生口，需要你自行安装 `playwright-core`，不再随包提供 |
| `BROWSER_PROFILE` | `off` | CDP 设备 profile：`off`、`windows-chrome-8`、`windows-chrome-16`、`macos-chrome-8` 或 `random`。对浏览器会话应用 UA、屏幕/DPR、时区、语言；不会影响 DuckDuckGo/Brave 等纯 HTTP 引擎。 |
| `DDG_BROWSER_FALLBACK` | `1` | DuckDuckGo 的 HTTP 路径返回 202/CAPTCHA 时，改用 CDP 浏览器请求 HTML 端点；显式设置 `BROWSER_PROFILE` 时使用它，否则使用一致的 `windows-chrome-8` 默认 profile；设为 `0` 关闭。 |
| `BROWSER_CDP_ENDPOINT` / `PLAYWRIGHT_CDP_ENDPOINT` | 空 | 远程 Chrome/Edge CDP 调试端点（如 `http://127.0.0.1:9222` 或 `ws://...`）；旧变量名，由 CDP 驱动使用 |
| `BROWSER_PATH` / `PLAYWRIGHT_EXECUTABLE_PATH` | 自动探测 | **Chromium 系**浏览器可执行文件的绝对路径；自动探测覆盖 Chrome / Edge / Chromium / Brave / Vivaldi / Opera 的标准安装位置，`CHROME_PATH` 与 `BROWSER_PATH` 优先且等价；旧变量名 |
| `BROWSER_HEADLESS` / `PLAYWRIGHT_HEADLESS` | `true` | 是否无头运行（Windows 下自动使用隐身独立桌面）；旧变量名 |
| `BROWSER_TIMEOUT_MS` / `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | `20000` | 页面导航硬超时（毫秒）；旧变量名，作用于 CDP 导航 |

#### 6. 🛠️ 应用目录与工具微调

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `MYWEBSEARCH_DATA_DIR` | `~/.my-websearch` | 配置文件与持久化 Cookie 的根存储目录 |
| `OPEN_WEBSEARCH_RESPONSE_CAP_BYTES` | `60000` | MCP 工具返回给大模型的最大字符上限，防止超长上下文撑爆模型窗口 |

> 💡 **零配置升级说明（已精简移除的冗余变量）**：
> - **CORS 跨域开关**（`ENABLE_CORS`/`CORS_ORIGIN`）：默认**关闭 CORS**；仅在浏览器跨域调用时显式开启，并限制允许来源。
> - **浏览器后端**：改用 `chrome-remote-interface` 的 raw CDP；`playwright-core` 不再随包提供。`PLAYWRIGHT_*` 与 `SEARCH_MODE=playwright` 仅作为兼容别名保留。
> - **Emoji 开关**（`OPEN_WEBSEARCH_NO_EMOJI`）：代码页自动探测（非 UTF-8 自动平滑降级为 ASCII 标签），不再需要开关。
> - **独立调试变量**（`OPEN_WEBSEARCH_DEBUG`）：全面收敛为标准化 `LOG_LEVEL=debug`。
> - **Cookie 保鲜期**（`MYWEBSEARCH_COOKIE_TTL_DAYS`）：固化为标准 30 天，到期自动续期。

---

<a id="development"></a>

## 🤝 参与开发与测试

欢迎提交 Issue 与 Pull Request！本地开发与测试命令：

```bash
npm install
npm run build
npm test              # 执行 Vitest 测试套件（文件/用例数由 npm test 输出）
npm run check:docs    # 校验 README 环境变量表与 docs/env-schema.json 一致（改 schema 后跑 npm run docs:env）
npm run test:live     # 执行实时网络集成测试
npm run eval:live     # 执行 23 用例真实 STDIO JSON-RPC 评测套件
```

### 致谢

**Author: wtznicy**

本项目基于 **Open-WebSearch**（原作者 Aas-ee）深度演进而来，特此致谢。同时感谢以下开源项目：
- **[wreq-js](https://www.npmjs.com/package/wreq-js)**：高性能原生 Chrome TLS/HTTP2 指纹与会话管理
- **[Context7](https://context7.com)**：实时权威官方框架/库文档索引
- **[Mozilla Readability](https://github.com/mozilla/readability) & [Turndown](https://github.com/mixmark-io/turndown)**：网页正文提纯与 Markdown 格式转换
