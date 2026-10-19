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

- 🌐 **13 大引擎融合与自适应路由**  
  聚合国内直连（**Bing、百度、CSDN、掘金、搜狗**）、海外通用（**DuckDuckGo、Brave、Startpage、Exa**）与垂直开发者平台（**GitHub、StackOverflow、Hacker News、arXiv**）。支持中文/英文按语种自动路由（`auto`）、多词并发检索（`queries`）、跨引擎去重排序与 `minResults` 自动级联补位。
- ⚡ **现代 Web 协议栈与前端算力求解（零浏览器轻量直通）**  
  基于 `wreq-js` 原生模拟现代浏览器 TLS/HTTP2 协议握手与长效会话机制；内置算法解析 **Startpage Anubis SHA-256 PoW 算力挑战** 与 **DuckDuckGo `d.js` (`isJsaChallenge`) 动态前端挑战**；真实 URL 快速解析（搜狗跳转页还原、百度 `Location` 直取、Bing Base64 解码）；无需拉起 400MB 浏览器即可稳定高效获取正文。
- 📄 **高纯度 Markdown 正文提纯与特色站点规则**  
  整合 Mozilla Readability 与容器级智能降噪，为**微信公众号**（`#js_content` 深度清洗）、**StackOverflow**（问答主体与采纳答案精准提纯）定制专属净化器，针对 **CSDN 与掘金** 自动走专用提取链路；精准保留文章主标题、代码围栏及 GFM 表格；支持长文无缝分页（`startIndex`）。
- 📚 **统一 Context7 官方框架/库文档直查（`queryDocs` 一站式合体）**  
  直接输入技术库名（如 `"next.js"`, `"vue"`）或 Context7 ID，内部自动多候选排序、404 自愈重搜并返回相似替代库，免去额外调用 ID 解析步骤。
- 🐙 **全面升级的 GitHub / Gitee 资源抓取**  
  `fetchGithubContent`（原 `fetchGithubReadme`）同时支持 GitHub 与 Gitee：仓库 README、任意源码单文件（`/blob/...`）、目录树（`/tree/...`）及 Issue / PR 完整讨论。
- 🌏 **零配置网络感知（TUN / Fake-IP 完美适配）**  
  自动嗅探系统代理（Windows 注册表 / macOS scutil / Linux 环境变量），海外引擎走代理、国内引擎直连；原生支持 `198.18.0.0/15` 放行，无缝兼容 TUN / 虚拟网卡，严守内网 SSRF 安全边界。
- 🔌 **全形态接入支持**  
  支持 **MCP STDIO**（Claude/Cursor 极简接入）、**Streamable HTTP / SSE**（Cherry Studio 等远程客户端）、**终端 CLI** 一次性工具，以及**本地常驻 Daemon**（支持连接池复用与 `/metrics` Prometheus 监控）。

---

## 🏗️ 系统架构

```mermaid
flowchart TB
    subgraph Clients["🤖 调用入口 (Entrypoints)"]
        MCP["MCP 协议服务<br/>(STDIO / Streamable HTTP / SSE)"]
        CLI["CLI 命令行<br/>(my-websearch search / fetch-*)"]
        Daemon["本地常驻 Daemon<br/>(127.0.0.1:3210 · /health · /metrics)"]
    end

    subgraph Core["🧠 核心编排层 (Search & Fetch Orchestrator)"]
        Router["语言感知自动路由 (Auto Router)<br/>中文 → Baidu/Sogou | 英文/代码 → Bing + DuckDuckGo"]
        Cascade["minResults 级联补位 & 熔断器<br/>(自适应 30s→5m + 5min TTL 缓存)"]
        Ranker["跨引擎 URL 归一化去重 & BM25 相关性重排"]
    end

    subgraph Transport["🛡️ 传输协议与安全防护 (Transport & Security)"]
        Wreq["wreq-js 原生 Chrome TLS/H2 指纹<br/>+ 会话级 Cookie 自动持久化"]
        Solvers["内置毫秒挑战求解器<br/>Startpage PoW | DDG JSA Solver"]
        PW["Playwright 隐身浏览器兜底<br/>(严格超时预算 + 跨进程文件锁治理)"]
        Guard["SSRF 防护 & Fake-IP 兼容<br/>(PROXY_URL 分流 + 198.18.0.0/15)"]
    end

    subgraph Engines["🌍 13 大引擎 + 6 大内容/文档服务"]
        CN["🇨🇳 国内直连引擎<br/>Bing · 百度 · CSDN · 掘金 · 搜狗"]
        INTL["🌐 海外与垂直引擎<br/>DuckDuckGo · Brave · Startpage · Exa<br/>GitHub · StackOverflow · HackerNews · arXiv"]
        Docs["📚 内容抓取与文档<br/>fetchWebContent · queryDocs · GitHub/Gitee · CSDN/掘金全文"]
    end

    Clients --> Core
    Core --> Transport
    Transport --> Engines
```

---

## 🌍 13 大搜索引擎一览

| 引擎标识 | 网络要求 | API Key | 核心技术与优势 | 最擅长场景 |
| :--- | :---: | :---: | :--- | :--- |
| **`bing`** | 🇨🇳 直连 | 无 | Chrome TLS 指纹 + Base64 真实链接解码 + 隐身兜底 | 综合技术检索、中英文混合查询 |
| **`baidu`** | 🇨🇳 直连 | 无 | 并发 `Location` 跳转直取 + 验证拦截状态精准识别 | 中文资讯、本土百科、国内论坛 |
| **`csdn`** | 🇨🇳 直连 | 无 | 自动持久化阿里云 WAF Cookie + 空壳响应智能重试 | 中文报错排查、开发踩坑笔记 |
| **`juejin`** | 🇨🇳 直连 | 无 | 掘金官方接口直调，极速提取干净长文 | 前端/后端现代中文高质量技术博文 |
| **`sogou`** | 🇨🇳 直连 | 无 | 桌面/移动双栈解析 + 跳转页快速还原 + 自动去推广 | 微信公众号外链、中文长尾问答 |
| **`duckduckgo`** | 🌐 需代理 | 无 | Preload `d.js` + **内置 `isJsaChallenge` 求解器**（HTTP 202 = 出口 IP 限流） | 英文技术检索、海外开源讨论 |
| **`startpage`** | 🌐 需代理 | 无 | **多 Worker Anubis SHA-256 PoW 求解器**（难度 ≤ 6）+ 隐私直通 | 谷歌同源高质量检索（隐私高保真） |
| **`brave`** | 🌐 需代理 | 无 | 原生指纹直连 + 赞助商商业推广深度剥离 | 独立海外英文索引、技术博客 |
| **`exa`** | 🌐 API直连 | 选配 Key | 官方语义搜索 API（未配置时自动跳过，不阻断级联） | 深度语义相似搜索、学术与技术前沿 |
| **`github`** | 🌐 需代理 | 无 | 官方 REST API 检索仓库与 Issue 问答 | 开源项目源码、开源库 Issues 排查 |
| **`stackoverflow`**| 🌐 需代理 | 无 | StackExchange 2.3 官方 API + HTML 实体智能解码 | 编程报错排错、高质量代码问答 |
| **`hackernews`** | 🌐 需代理 | 无 | Algolia HN API，含 points、评论数与作者元信息 | 极客社区讨论、前沿科技热点与观点 |
| **`arxiv`** | 🌐 需代理 | 无 | 官方 Atom XML API 检索论文标题、作者与摘要 | 计算机科学、AI/ML 与自然科学最新论文 |
| **`code`** | 🇨🇳 直连 | 无 | grep.app API 实时检索全球 GitHub 代码，含仓库、文件路径与精确代码行 | 源码实现翻查、API 使用范例、开源语法实战 |

---

<a id="mcp-tools"></a>

## 🛠️ 4 大核心 MCP 工具（极简高效，低 Token 消耗）

> 💡 **Token 预算与瘦身**：所有工具描述均严格控制在 250 字符以内（总描述字符 ≤ 1000），更详细的路由策略已移入 `McpServer({ instructions })`，大幅降低宿主 LLM 的 Context 开销。

| 工具名称 | 功能定位 | 关键特性 |
| :--- | :--- | :--- |
| **`search`** | 14 大引擎联合联网与代码检索 | 支持多词并发、`timeRange: day\|week\|month\|year` 时间过滤、`site: string[]` 域名过滤、`fetchTop` 正文前瞻注入、`code` 代码引擎（grep.app）；显式传 `engines` 默认 `minResults=0` 且仅在候选内级联；失败附带网络内联诊断（`diagnostics: { proxy, dns, suggestion }`） |
| **`fetchWebContent`** | 通用网页正文、Markdown 与透明 PDF 提取 | **全能知识提取网关**：内置磁盘级 Markdown 缓存（Node 22 `node:sqlite` / 分片 JSON 兜底，200MB LRU，`cache: default\|reload` 强制刷新）；透明解析 PDF（上限 20MB / 50 页，带 `[page N]` 标记，纯扫描版明确报错）；统一分页与 `focus` 章节定位 |
| **`fetchGithubContent`** | 全能 GitHub / Gitee 内容提取网关 | 提取 README、**单个源码文件**（`/blob/<ref>/<path>`）、目录树（`/tree/`）、Issue 与 PR；`ref` 可为分支/tag/commit；不是整仓 clone；Gitee 已与 GitHub 对齐（文件/目录/Issue/PR，可选 `GITEE_TOKEN`）；返回 `warnings` |
| **`queryDocs`** | 一站式开源框架/库官方文档 | 直接传入库名或 Context7 ID；内置低置信度保护与自动兜底链（npm registry → PyPI JSON → 官方 GitHub README），响应标注 `source: context7\|npm\|pypi\|github-readme`、`confidence` 与 `warnings` |

> 💡 **向后兼容说明**：原独立的 `fetchCsdnArticle` 与 `fetchJuejinArticle` 已平滑下沉并收口进通用的 `fetchWebContent`（按域名自动采用最佳专有提取引擎）；原 `resolveLibraryId` 已合并入 `queryDocs`（支持直接传 `library` 库名或旧版 `libraryId` 别名自动解析定位）。如需向大模型显式暴露旧版独立工具，可配置 `REGISTER_LEGACY_ARTICLE_TOOLS=true`。

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

#### 🔹 Claude Desktop / Cursor / Windsurf / Cline (STDIO 极简模式)

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

*(Windows 环境若遇环境缺失，可将 `command` 设为 `cmd`，`args` 设为 `["/c", "npx", "-y", "my-websearch@latest"]`)*

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

# 启动本地常驻 Daemon（复用底层连接池与缓存，默认端口 3210）
my-websearch serve

# 终端一次性搜索（自动复用运行中的 Daemon）
my-websearch search "Model Context Protocol 最佳实践" --limit 5 --min-results 5 --json

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
# 检查本地配置与浏览器
my-websearch doctor

# 执行真实代理/引擎探测（会访问上游服务）
my-websearch doctor --network

# 只探测指定引擎，并输出 JSON
my-websearch doctor --network --engine bing,duckduckgo --json

# 重置并清除引擎熔断与健康状态缓存
my-websearch doctor --reset-health
```

报告会区分配置状态、代理 TCP 连通性、HTTP 连通性、应用层解析、浏览器启动和交互验证状态。网络模式会发起真实请求，不建议高频执行。

### 🌐 代理排障与上游频控辨析

在配置或调试代理时，如果遇到异常表现，请对照以下高频排查点：

1. **启动日志显示 `🌐 Proxy: disabled`，但明明配置了 `proxy.url`？**
   - **排查 `useProxy` 字段**：在 `~/.my-websearch/config.json` 中，若配置了 `"useProxy": false`，根据配置优先级规则，该参数会**显式覆盖并强制禁用 `url`**（产生 `PROXY_URL='false'`），导致代理被静默关闭。请将 `"useProxy"` 改为 `true` 或直接删除该字段（只要存在有效 `url` 即可自动启用代理）。
   - **未开启系统代理且未配 `PROXY_URL`**：纯直连网络下（未开启本地网络代理环境），国际引擎无法直接连通，此时请显式设置 `PROXY_URL`（如 `http://127.0.0.1:7890` 或 `7897`）。

2. **配置了有效代理后，国际引擎依然失败或超时？（上游 IP 频控限流，非本地配置错误）**
   - **DuckDuckGo 返回 HTTP 202 / 验证挑战**：DDG 对当前公网出口 IP 触发了频控限制；可能首条查询成功、后续返回 `anomalyDetectionBlock`，Cookie 机制无法解除上游限流。请更换网络出口 IP 或等待频控冷却。
   - **Bing 返回 HTTP 200 但 0 条结果**：wreq 协议路径解析为空时会自动回退到 axios 网页路径；若两条路径都为空，通常是查询词或 IP 受到频控策略限制。
   - **Brave 返回 HTTP 429 (Too Many Requests)**：Brave 搜索对高频共享出口 IP 进行了速率限制，此错误属于出口 IP 请求过频。
   - **Startpage 请求挂满超时或 Anubis PoW 难度过大**：难度 6 现由最多 4 个 Worker 并行求解（约 3–12s）；难度 >6 会自动跳过；pass-challenge 的 socket 错误/瞬时 5xx 会自动重试。
   - 💡 **解决方案**：上述情况**并非本地客户端或 MCP 服务配置错误**，而是公网出口 IP 触发了上游搜索引擎的访问频控。请**更换代理服务出口 IP**，或在搜索时使用 `engines: ["bing", "baidu"]` 降级，亦可配置官方 API Key（如 `BRAVE_API_KEY`）直连官方高可用通道。

<a id="configuration"></a>

## ⚙️ 配置中心与环境变量

### 统一配置文件（`~/.my-websearch/config.json`）

为避免在不同 MCP 客户端中反复声明参数，支持全局统一配置：

```json
{
  "apiKeys": {
    "context7": "ctx7sk-...",
    "exa": "..."
  },
  "proxy": {
    "url": "http://127.0.0.1:7897",
    "useProxy": true,
    "engines": ["duckduckgo", "exa", "brave", "startpage"]
  }
}
```

> ⚠️ **关于 `useProxy` 的重要说明**：只要配置了 `"url"`，代理默认就会自动启用。如果显式配置了 `"useProxy": false`，会**强制覆盖并废掉 `url`**。因此若要启用代理，请将该字段设为 `true` 或直接省略不写。

### 📋 环境变量完整全量参考

支持通过全局配置文件（`~/.my-websearch/config.json`）、本地 `.env` 或系统环境变量设置：

#### 1. 🔍 检索与路由编排

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `DEFAULT_SEARCH_ENGINE` | `auto` | 默认搜索引擎。`auto`（智能感知路由：中文走 `baidu,sogou`，英文走 `bing,duckduckgo`）。支持全部 13 个引擎：`auto`、`bing`、`baidu`、`sogou`、`duckduckgo`、`brave`、`csdn`、`juejin`、`startpage`、`exa`、`github`、`stackoverflow`、`hackernews`、`arxiv`（垂直开发者引擎可配置为默认，全局默认推荐保持 `auto` 或通用网页引擎） |
| `ALLOWED_SEARCH_ENGINES` | 全部 | 限制启用的引擎白名单（逗号分隔，如 `bing,baidu,duckduckgo`） |
| `BING_BASE_URL` | `https://cn.bing.com/search` | Bing 搜索请求基址。国际用户可改为 `https://www.bing.com/search` 或自定义中转域名（兼容旧变量 `OPEN_WEBSEARCH_BING_HOST`） |
| `DEFAULT_MIN_RESULTS` | `5` | 级联补位阈值：可用结果数不足该值时，自动调度备用引擎补齐 |
| `DEFAULT_SEARCH_LIMIT` | `10` | 工具调用未显式传 `limit` 时的单次返回上限（最大 50） |
| `SEARCH_DEADLINE_MS` | `30000` | 搜索任务全局超时硬预算（毫秒） |
| `ENGINE_CIRCUIT_BASE_COOLDOWN_MS` | `30000` | 引擎首次熔断冷却（429 / 202 / 验证状态）。连续失败指数退避（30s → 60s → 120s…）。 |
| `ENGINE_CIRCUIT_MAX_COOLDOWN_MS` | `300000` | 熔断指数退避上限（默认 5 分钟）。 |
| `SEARCH_AUTHORITY_DOMAINS` | 空 | 结果重排的额外权威域名白名单（逗号分隔，追加到内置白名单） |
| `SEARCH_MODE` | `auto` | 检索模式与浏览器启动策略。支持单模式、一种方式多选引擎、以及多启动方式组合：<br/>• **全局模式**：`auto`（默认允许兜底）、`request`/`none`（全纯HTTP防爆内存）、`playwright`（全强走浏览器）<br/>• **一种方式多选引擎**：`playwright:bing,startpage`、`auto:bing,startpage`、`bing,startpage`<br/>• **多选启动方式组合**：`playwright:bing;auto:startpage`（bing强走渲染，startpage走自动兜底）、`auto;request:startpage`（全局auto但startpage走纯HTTP） |
| `AUTO_ROUTE_EN_ENGINES` | `bing,duckduckgo` | 英文查询默认自动路由引擎列表（逗号分隔） |
| `AUTO_ROUTE_ZH_ENGINES` | `baidu,sogou` | 中文查询默认自动路由引擎列表（逗号分隔） |

#### 2. 🌐 代理与网络安全

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `PROXY_URL` | 空（关闭） | 统一上游代理配置（已合并原 `USE_PROXY` 与 `PROXY_ENGINES`，TUN 模式无需配置保持直连）。<br/>• **开启默认代理**：传空值 `PROXY_URL=""` 或 `PROXY_URL=true` 即可启用默认 `http://127.0.0.1:7897`（常见本地代理端口如 7897、7890、10809；默认仅国际引擎走代理，国内引擎直连）<br/>• **自定义地址**：`PROXY_URL=http://127.0.0.1:10809`<br/>• **自选引擎**：`PROXY_URL="http://127.0.0.1:7897;duckduckgo,brave"` 或全部引擎走代理 `PROXY_URL=";all"` |
| `FAKE_IP_CIDRS` | `198.18.0.0/15` | Fake-IP 虚拟网段白名单，避免误触发 SSRF 本地私网地址拦截 |
| `IMPERSONATE_BROWSER` | `chrome_149` | `wreq-js` 模拟的现代浏览器 TLS/H2 指纹（如 `chrome_149`, `safari_18`） |
| `IMPERSONATE_OS` | `windows` | 指纹模拟使用的操作系统平台（`windows`, `macos`, `linux`） |
| `BING_IMPERSONATE` | `true` | 是否启用 Bing 的 Chrome TLS 指纹模拟（连续多次返回 0 条时会自动熔断降级为标准 HTTP） |
| `ANUBIS_MAX_POW_DIFFICULTY` | `6` | Startpage Anubis 工作量证明（PoW）难度上限，超限时自动跳过或走降级策略 |
| `DIRECT_FIRST_PROBE_TIMEOUT_MS` | `3500` | 直连优先策略探测超时时间（毫秒） |
| `FETCH_WEB_INSECURE_TLS`| `false` | 仅对 `fetchWebContent` 关闭 TLS 证书校验（目标站点旧证书链损坏时使用） |
| `GITHUB_README_CDN_FIRST` | `false` | 为 `true` 时强制跳过 `raw.githubusercontent.com` 直连探测，优先走 jsDelivr CDN 镜像（国内无代理网络加速，免除 3 秒直连探测等待） |

#### 3. 🔐 外部服务凭据与 API Key

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `CONTEXT7_API_KEY` | 空 | [Context7 API Key](https://context7.com/dashboard)（强烈推荐 TUN/代理用户配置，免受共享 IP 200次/月限额影响） |
| `EXA_API_KEY` | 空 | [Exa 官方免费 Key](https://dashboard.exa.ai/api-keys)（仅使用 `exa` 语义搜索时需要） |
| `BRAVE_API_KEY` | 空 | [Brave Search API Key](https://api.search.brave.com/app/keys)（选配，配置后优先走官方 API 高可靠检索） |
| `GITHUB_TOKEN` | 空 | [GitHub Personal Access Token](https://github.com/settings/tokens)（选配，提高 GitHub 搜索与内容抓取的速率配额至 5,000次/小时） |
| `GITEE_TOKEN` | 空 | [Gitee Personal Access Token](https://gitee.com/profile/personal_access_tokens)（选配，提高 Gitee API 配额并支持私有仓库） |
| `STACKOVERFLOW_API_KEY` | 空 | [Stack Apps Key](https://stackapps.com/apps/oauth/register)（选配，提高 StackOverflow 检索配额至 10,000次/天） |

#### 4. 🖥️ 服务模式、并发与会话治理

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `MODE` | `both` | MCP 传输通道：`stdio`（仅标准输入输出）、`http`（仅网络接口）、`both`（同时开启） |
| `PORT` | `3211` | MCP HTTP/SSE 监听端口（CLI 本地常驻 Daemon 默认使用 `3210`） |
| `MAX_CONCURRENT_SEARCHES`| `20` | Daemon 模式下的全局最大并发搜索数（`0` 表示不限制） |
| `MCP_MAX_SESSIONS` | `100` | 保留的最大并发会话上限，超限时返回 HTTP 429 保护服务器内存 |
| `MCP_SESSION_TTL_MS` | `1800000` | 会话空闲回收时长（默认 30 分钟） |
| `MCP_SESSION_REAPER_MS` | `300000` | 会话清理器扫描巡检间隔（默认 5 分钟） |
| `LOG_LEVEL` | `info` | 日志输出级别：`quiet`（完全静默）、`debug`、`info`、`warn`、`error` |
| `SECURITY_AUDIT` | `false` | 是否开启安全审计日志（输出 SSRF 拦截详情与主机头放行记录） |
| `OPEN_WEBSEARCH_ALLOWED_HOSTS` | 本地回环 | HTTP 服务允许的 Host 域名白名单（DNS Rebinding 安全防护，逗号分隔） |

#### 5. 🧭 Playwright 浏览器高级控制

> [!NOTE]
> 原有的 `BING_PLAYWRIGHT_FALLBACK` 与 `STARTPAGE_PLAYWRIGHT_FALLBACK` 已全面合并收敛至 `SEARCH_MODE`（如 `SEARCH_MODE=bing` 或 `SEARCH_MODE=request`），底层已自动保持静默向后兼容。

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `PLAYWRIGHT_CDP_ENDPOINT` | 空 | 远程 Chrome/Edge CDP 调试端点（如 `http://127.0.0.1:9222` 或 `ws://...`） |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 自动探测 | 自定义浏览器二进制可执行文件绝对路径（默认自动探测 Edge/Chrome） |
| `PLAYWRIGHT_HEADLESS` | `true` | 是否无头运行（Windows 下自动使用隐身独立桌面，绝不弹窗打扰用户） |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS`| `20000` | Playwright 页面导航硬超时（毫秒） |

#### 6. 🛠️ 应用目录与工具微调

| 变量名 | 默认值 | 可选值 / 说明 |
| :--- | :--- | :--- |
| `MYWEBSEARCH_DATA_DIR` | `~/.my-websearch` | 配置文件与持久化 Cookie 的根存储目录 |
| `OPEN_WEBSEARCH_RESPONSE_CAP_BYTES`| `60000` | MCP 工具返回给大模型的最大字符上限，防止超长上下文撑爆模型窗口 |
| `MCP_TOOL_SEARCH_NAME` | `search` | 自定义搜索工具在 MCP 中的注册名称 |
| `MCP_TOOL_FETCH_WEB_NAME` | `fetchWebContent` | 自定义正文抓取工具在 MCP 中的注册名称 |
| `MCP_TOOL_FETCH_GITHUB_NAME` | `fetchGithubContent` | 自定义 GitHub/Gitee 内容工具在 MCP 中的注册名称（设为 `fetchGithubReadme` 可保持旧名） |

> 💡 **零配置升级说明（已精简移除的冗余变量）**：
> - **CORS 跨域开关**（`ENABLE_CORS`/`CORS_ORIGIN`）：默认**关闭 CORS**；仅在浏览器跨域调用时显式开启，并限制允许来源。
> - **Playwright 包选择**（`PLAYWRIGHT_PACKAGE`/`PLAYWRIGHT_MODULE_PATH`）：现已实现**100% 自动探测**系统自带浏览器与已装包。
> - **远程调试端点**（`PLAYWRIGHT_WS_ENDPOINT`）：统一收敛为标准 `PLAYWRIGHT_CDP_ENDPOINT`。
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
npm test              # 执行 Vitest 测试套件（当前基线：54 个文件、450 个测试）
npm run test:live     # 执行实时网络集成测试
npm run eval:live     # 执行 23 用例真实 STDIO JSON-RPC 评测套件
```

### 致谢

**Author: wtznicy**

本项目基于 **Open-WebSearch**（原作者 Aas-ee）深度演进而来，特此致谢。同时感谢以下开源项目：
- **[wreq-js](https://www.npmjs.com/package/wreq-js)**：高性能原生 Chrome TLS/HTTP2 指纹与会话管理
- **[Context7](https://context7.com)**：实时权威官方框架/库文档索引
- **[Mozilla Readability](https://github.com/mozilla/readability) & [Turndown](https://github.com/mixmark-io/turndown)**：网页正文提纯与 Markdown 格式转换
