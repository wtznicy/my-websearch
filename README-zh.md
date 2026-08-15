<div align="center">

# MyWebSearch

**中文 | [English](./README.md)**

![npm version](https://img.shields.io/npm/v/my-websearch)
![npm downloads](https://img.shields.io/npm/dm/my-websearch)
![license](https://img.shields.io/npm/l/my-websearch)
![GitHub stars](https://img.shields.io/github/stars/wtznicy/my-websearch)

</div>

`my-websearch` 是一个**免 API Key 的多引擎联网搜索 MCP server**，同时提供 CLI 与本地 daemon。内置 Bing、百度、CSDN、DuckDuckGo、Exa、Brave、掘金、Startpage、搜狗等多个搜索引擎，以及 CSDN/掘金/GitHub README/通用网页的正文抓取能力。

## 功能特性

- 多引擎搜索：
  - 国内引擎（直连即可）：`bing`、`baidu`、`csdn`、`juejin`、`sogou`
  - 境外引擎（⚠️ **中国大陆用户需开启代理**）：`duckduckgo`、`exa`、`brave`、`startpage`
- 支持 HTTP 代理（按引擎白名单路由，`PROXY_ENGINES`），除 exa 外无需 API Key、无需注册（exa 可选配置 `EXA_API_KEY`，见下文）
- 跨引擎结果去重融合 + TTL 缓存（5 分钟，可手动清空）
- `minResults` 级联：某引擎失败时自动用其他引擎补足结果数
- 正文抓取：CSDN 文章、掘金文章、GitHub README、任意 HTTP(S) 网页 / Markdown
- context7 融合：`resolveLibraryId` / `queryDocs` 直接检索库/框架官方文档（带来源信誉评分）
- 网页抓取自动处理 GBK/GB2312 编码，长文档支持 `startIndex` 分页

## 快速开始

用 NPX 直接运行（无需安装）：

```bash
# 基本使用（默认 stdio 模式，供 MCP 客户端连接）
npx my-websearch@latest
```

### 全局安装

```bash
npm install -g my-websearch
my-websearch
```

## 在 MCP 客户端中配置

### Cherry Studio

**方式一：NPX 启动（推荐）**

```json
{
  "mcpServers": {
    "my-websearch": {
      "command": "npx",
      "args": ["-y", "my-websearch@latest"],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "bing"
      }
    }
  }
}
```

**方式二：本地构建（Windows 示例）**

```json
{
  "mcpServers": {
    "my-websearch-local": {
      "command": "node",
      "args": ["C:/你的路径/my-websearch/build/index.js"],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "bing"
      }
    }
  }
}
```

**方式三：HTTP 模式**

```json
{
  "mcpServers": {
    "web-search": {
      "name": "Web Search MCP",
      "type": "streamableHttp",
      "baseUrl": "http://localhost:3211/mcp"
    }
  }
}
```

> HTTP 模式默认监听 `127.0.0.1:3211`（MCP 客户端连不上时，检查服务是否已用 `PORT` 启动、端口是否被占用）。

### Claude Desktop

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

### VSCode（Claude Dev 扩展）

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

## 环境变量

| 变量名 | 默认值 | 可选值 | 说明 |
|--------|--------|--------|------|
| `DEFAULT_SEARCH_ENGINE` | `bing` | `bing`, `duckduckgo`, `exa`, `brave`, `baidu`, `csdn`, `juejin`, `startpage`, `sogou` | 默认搜索引擎 |
| `ALLOWED_SEARCH_ENGINES` | 空（全部可用） | 逗号分隔的引擎名 | 限制可用的搜索引擎；默认引擎不在列表时取第一个 |
| `SEARCH_MODE` | `auto` | `request`, `auto`, `playwright` | 仅对 Bing 生效：仅请求 / 请求失败回退 Playwright / 强制 Playwright |
| `BING_PLAYWRIGHT_FALLBACK` | `true` | `true`, `false` | `false` 时 Bing 被反爬直接报错，交给 `minResults` 级联换轻量引擎，不启动 Playwright 浏览器 |
| `ENABLE_CORS` | `false` | `true`, `false` | 启用 CORS |
| `CORS_ORIGIN` | `*` | 任意来源 | CORS 来源配置 |
| `USE_PROXY` | `false` | `true`, `false` | 启用 HTTP 代理 |
| `PROXY_URL` | `http://127.0.0.1:7890` | 任意有效 URL | 代理服务器 URL |
| `PROXY_ENGINES` | 空（全部引擎） | 逗号分隔的引擎名 | `USE_PROXY=true` 时**仅白名单内的引擎走代理**，其余直连；空 = 全部引擎走代理（旧全局行为）。中国大陆用户推荐：`PROXY_ENGINES=duckduckgo,exa,brave,startpage`（境外引擎走代理、国内引擎直连，避免国内引擎绕行代理导致超时/301） |
| `FETCH_WEB_INSECURE_TLS` | `false` | `true`, `false` | 仅对 `fetchWebContent` 关闭 TLS 证书校验（目标站点证书异常时临时用） |
| `MODE` | `both` | `both`, `http`, `stdio` | 服务器模式：HTTP+STDIO / 仅 HTTP / 仅 STDIO |
| `PORT` | `3211` | 1-65535 | HTTP 模式端口（CLI daemon 默认 3210） |
| `PLAYWRIGHT_PACKAGE` | `auto` | `auto`, `playwright`, `playwright-core` | 浏览器模式优先解析的 Playwright 客户端包 |
| `PLAYWRIGHT_MODULE_PATH` | 空 | 绝对路径 | 复用项目外已安装的 Playwright 包 |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 空 | 浏览器二进制路径 | 用现有 Chromium/Chrome 启动 |
| `PLAYWRIGHT_WS_ENDPOINT` | 空 | `ws://` / `wss://` 地址 | 连接远端 Playwright 浏览器服务 |
| `PLAYWRIGHT_CDP_ENDPOINT` | 空 | Chromium CDP 地址 | 通过 CDP 连接现有 Chromium |
| `PLAYWRIGHT_HEADLESS` | `true` | `true`, `false` | 是否无头模式 |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | `20000` | 正整数 | 页面导航与 Bing 结果等待超时 |
| `MCP_TOOL_SEARCH_NAME` | `search` | 合法 MCP 工具名 | 自定义 search 工具名 |
| `MCP_TOOL_FETCH_CSDN_NAME` | `fetchCsdnArticle` | 合法 MCP 工具名 | 自定义 CSDN 抓取工具名 |
| `MCP_TOOL_FETCH_GITHUB_NAME` | `fetchGithubReadme` | 合法 MCP 工具名 | 自定义 GitHub README 工具名 |
| `MCP_TOOL_FETCH_JUEJIN_NAME` | `fetchJuejinArticle` | 合法 MCP 工具名 | 自定义掘金抓取工具名 |
| `MCP_TOOL_FETCH_WEB_NAME` | `fetchWebContent` | 合法 MCP 工具名 | 自定义网页抓取工具名 |
| `EXA_API_KEY` | 空 | 任意有效 Exa API key | **可选**（仅 exa 引擎需要）。exa 的免 key 网页端点已失效，想用 exa 引擎时在 [https://dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) 免费申请并配置到 MCP 客户端 env；不配置只影响 exa 一个引擎，其余引擎不受影响 |
| `LOG_LEVEL` | `normal` | `normal`, `quiet` | `quiet` 抑制启动配置日志（MCP stdio 裸启动默认已静默；诊断时可用 `LOG_LEVEL=normal` 恢复） |
| `OPEN_WEBSEARCH_QUIET_STARTUP` | `false` | `true`, `false` | 抑制启动配置日志（兼容开关，`LOG_LEVEL=quiet` 与之等价） |

### 可选：配置 EXA_API_KEY（仅想用 exa 引擎时需要）

`EXA_API_KEY` 是**可选配置**——其余引擎（bing、baidu、csdn、juejin、sogou、duckduckgo、brave、startpage）都不需要它。只有想用 `exa` 时才配置：exa 的旧免 key 网页端点已被上游关闭（返回 500），需要在 [https://dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) 免费申请 key，并配置到你的 MCP 客户端：

**Claude Desktop**（`claude_desktop_config.json`）：
```json
{
  "mcpServers": {
    "web-search": {
      "command": "npx",
      "args": ["-y", "my-websearch@latest"],
      "env": {
        "MODE": "stdio",
        "EXA_API_KEY": "<your-key>"
      }
    }
  }
}
```

**Cherry Studio / VSCode（Claude Dev）**：同样在 server 的 `env` 字段加 `"EXA_API_KEY": "<your-key>"`。

**ZCode**（`~/.zcode/cli/config.json` → `mcp.servers`）：
```json
"my-websearch": {
  "type": "stdio",
  "command": "D:\\nodejs\\node.exe",
  "args": ["D:\\path\\to\\build\\index.js"],
  "env": {
    "MODE": "stdio",
    "EXA_API_KEY": "<your-key>"
  }
}
```

**CLI 一次性使用（无需配置文件）**：
```bash
EXA_API_KEY=<your-key> my-websearch search "query" --engines exa
# Windows PowerShell：
# $env:EXA_API_KEY="<your-key>"; my-websearch search "query" --engines exa
```

未配置 key 时，exa 引擎会快速失败并返回包含以上配置指引的错误信息，而不是静默返回空结果。

### 常用配置示例

```bash
# 启用代理（网络受限地区）
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 npx my-websearch@latest

# 按引擎代理（推荐，中国大陆）：仅境外引擎走代理，国内引擎直连
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 PROXY_ENGINES=duckduckgo,exa,brave,startpage npx my-websearch@latest

# 默认引擎使用 bing
DEFAULT_SEARCH_ENGINE=bing npx my-websearch@latest

# 关闭 Bing 的 Playwright 兜底，反爬时自动级联其他引擎
BING_PLAYWRIGHT_FALLBACK=false npx my-websearch@latest
```

## 可选：Playwright 浏览器增强

Bing 的 `playwright` 模式（以及部分网站的 cookie/渲染兜底）需要手动安装：

```bash
npm install playwright
npx playwright install chromium
SEARCH_MODE=auto npx my-websearch@latest
```

或者只装精简客户端、复用现有浏览器：

```bash
npm install playwright-core
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium SEARCH_MODE=auto npx my-websearch@latest
```

**建议**：个人日常使用若不想为 Bing 反爬启动重浏览器（3-8 秒冷启动、约 400MB 内存），设置 `BING_PLAYWRIGHT_FALLBACK=false`，并在搜索时让引擎分担压力：`engines: ["duckduckgo", "brave"]`。

## CLI 与本地 daemon

CLI 适合一次性执行；本地 daemon 是常驻 HTTP 服务，适合反复调用。

```bash
# 构建（本地源码时）
npm run build

# 启动 daemon
my-websearch serve

# 查看状态
my-websearch status --json

# 一次性搜索
my-websearch search "open web search" --limit 5 --json

# 结果不足 8 条时自动用其他引擎补位
my-websearch search "open web search" --min-results 8 --json

# 清空搜索 TTL 缓存（引擎刚恢复时用）
my-websearch cache-clear
```

daemon HTTP API（`GET /health`、`POST /search`、`POST /fetch-*`、`POST /cache/clear`）详见 [docs/http-api.md](docs/http-api.md)。

## 工具说明

MCP 共提供 7 个工具：

| 工具 | 用途 |
|------|------|
| `search` | 多引擎搜索，返回去重融合结果；支持 `engines`、`limit`、`searchMode`、`minResults` |
| `fetchCsdnArticle` | 抓取 CSDN 文章全文 |
| `fetchGithubReadme` | 抓取 GitHub / Gitee 仓库 README（Gitee 走官方 API，无需代理） |
| `fetchWebContent` | 抓取任意 HTTP(S) 网页 / Markdown，支持编码探测与分页 |
| `fetchJuejinArticle` | 抓取掘金文章全文 |
| `resolveLibraryId` | 把库/框架名解析为 context7 库 ID（带信誉/质量评分） |
| `queryDocs` | 按库 ID 检索官方文档片段与代码示例（版本可钉定） |

### search 示例

```json
{
  "query": "Python asyncio 教程",
  "limit": 5,
  "engines": ["bing", "csdn", "juejin"],
  "minResults": 5
}
```

### fetchWebContent 示例

```json
{
  "url": "https://gitee.com/wtznicy/my-websearch/raw/main/README.md",
  "maxChars": 12000
}
```

长文档用返回的 `nextStartIndex` 作为下一次调用的 `startIndex` 继续读取。

## 使用限制

- **中国大陆网络**：`duckduckgo`、`exa`、`brave`、`startpage` 为境外引擎，**不开代理会直接超时/失败**；`bing`、`baidu`、`csdn`、`juejin`、`sogou` 可直连。建议配置 `USE_PROXY=true` + `PROXY_ENGINES=duckduckgo,exa,brave,startpage`，让境外引擎走代理、国内引擎保持直连。若搜索时未开代理而包含境外引擎，它们会以 `partialFailures` 形式报错，其余结果仍正常返回——属预期行为
- 未开代理时境外引擎（`duckduckgo`/`brave`/`startpage`）会**快速失败**而不是挂满超时：程序会先探测直连可达性（3 秒超时、失败重试 1 次、结果缓存 5 分钟），不可达立即返回"需要代理，或改用国内引擎"；海外直连用户不受影响。`exa` 不参与探测——`api.exa.ai` 国内可直连（仅需 `EXA_API_KEY`）。已配置代理的引擎不探测，直接走代理
- 搜索引擎为免费接口，可能遇到反爬/限流；Bing 最常见。应对：多引擎分担（`engines`）、`minResults` 级联、`BING_PLAYWRIGHT_FALLBACK=false`、或设置代理
- `brave` 对连续自动化请求限流最严：突发搜索后会持续返回 429（恢复窗口分钟级，即使走住宅代理 IP 也一样）。建议低频使用，日常海外搜索以 `duckduckgo` / `startpage` 为主（稳定且质量相近）；brave 被限时快速失败，`minResults` 级联会自动换引擎补位
- 依赖浏览器 cookie / JS 渲染的页面，需安装 Playwright 才能兜底抓取
- 国内网络下 GitHub 相关域名可能无法直接解析，可用 `fetchWebContent` + jsDelivr 镜像（`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/README.md`）

## 相关链接

- HTTP API 文档：[docs/http-api.md](docs/http-api.md)
- 使用 skill 与 agent 工作流：仓库内 `skills/my-websearch/` 提供 `my-websearch` skill（`npx skills add` 安装），可引导 agent 执行搜索、抓取与多步分析

## 作者与致谢

**作者：wtznicy**

本项目基于 **Open-WebSearch**（原作者 Aas-ee）修改而来，感谢原作者的出色工作。

同时感谢以下开源项目：
- **context7**（Upstash）：为 `resolveLibraryId` / `queryDocs` 提供库/框架官方文档检索能力
- **fetch**（MCP 官方 servers）：为 `fetchWebContent` 的网页抓取设计提供参考
