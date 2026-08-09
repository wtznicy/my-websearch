<div align="center">

# Open-WebSearch

[![ModelScope](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Aas-ee/3af09e0f4c7821fb2e9acb96483a5ff0/raw/badge.json&color=%23de5a16)](https://www.modelscope.cn/mcp/servers/Aasee1/open-webSearch)
[![smithery badge](https://smithery.ai/badge/@Aas-ee/open-websearch)](https://smithery.ai/server/@Aas-ee/open-websearch)
![Version](https://img.shields.io/github/v/release/Aas-ee/open-websearch)
![License](https://img.shields.io/github/license/Aas-ee/open-websearch)
![Issues](https://img.shields.io/github/issues/Aas-ee/open-websearch)

**中文 | [English](./README.md)**

</div>

`open-websearch` 是一个**免 API Key 的多引擎联网搜索 MCP server**，同时提供 CLI 与本地 daemon。内置 Bing、百度、CSDN、DuckDuckGo、Exa、Brave、掘金、Startpage、搜狗等多个搜索引擎，以及 CSDN/掘金/GitHub README/通用网页的正文抓取能力。

## 功能特性

- 多引擎搜索：`bing`、`baidu`、`csdn`、`duckduckgo`、`exa`、`brave`、`juejin`、`startpage`、`sogou`
- 支持 HTTP 代理，无 API Key、无需注册
- 跨引擎结果去重融合 + TTL 缓存（5 分钟，可手动清空）
- `minResults` 级联：某引擎失败时自动用其他引擎补足结果数
- 正文抓取：CSDN 文章、掘金文章、GitHub README、任意 HTTP(S) 网页 / Markdown
- context7 融合：`resolveLibraryId` / `queryDocs` 直接检索库/框架官方文档（带来源信誉评分）
- 网页抓取自动处理 GBK/GB2312 编码，长文档支持 `startIndex` 分页

## 快速开始

用 NPX 直接运行（无需安装）：

```bash
# 基本使用（默认 stdio 模式，供 MCP 客户端连接）
npx open-websearch@latest
```

### 全局安装

```bash
npm install -g open-websearch
open-websearch
```

## 在 MCP 客户端中配置

### Cherry Studio

**方式一：NPX 启动（推荐）**

```json
{
  "mcpServers": {
    "open-websearch": {
      "command": "npx",
      "args": ["-y", "open-websearch@latest"],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "duckduckgo"
      }
    }
  }
}
```

**方式二：本地构建（Windows 示例）**

```json
{
  "mcpServers": {
    "open-websearch-local": {
      "command": "node",
      "args": ["C:/你的路径/open-websearch/build/index.js"],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "duckduckgo"
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
    "open-websearch": {
      "command": "npx",
      "args": ["-y", "open-websearch@latest"],
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
    "open-websearch": {
      "command": "npx",
      "args": ["-y", "open-websearch@latest"],
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

### 常用配置示例

```bash
# 启用代理（网络受限地区）
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 npx open-websearch@latest

# 默认引擎改为 duckduckgo（更稳定，降低 Bing 反爬影响）
DEFAULT_SEARCH_ENGINE=duckduckgo npx open-websearch@latest

# 关闭 Bing 的 Playwright 兜底，反爬时自动级联其他引擎
BING_PLAYWRIGHT_FALLBACK=false npx open-websearch@latest
```

## 可选：Playwright 浏览器增强

Bing 的 `playwright` 模式（以及部分网站的 cookie/渲染兜底）需要手动安装：

```bash
npm install playwright
npx playwright install chromium
SEARCH_MODE=auto npx open-websearch@latest
```

或者只装精简客户端、复用现有浏览器：

```bash
npm install playwright-core
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium SEARCH_MODE=auto npx open-websearch@latest
```

**建议**：个人日常使用若不想为 Bing 反爬启动重浏览器（3-8 秒冷启动、约 400MB 内存），设置 `BING_PLAYWRIGHT_FALLBACK=false`，并在搜索时让引擎分担压力：`engines: ["duckduckgo", "brave"]`。

## Docker 部署

```bash
docker run -d --name web-search -p 3211:3211 -e ENABLE_CORS=true -e CORS_ORIGIN=* \
  ghcr.io/aas-ee/open-web-search:latest
```

或使用 Docker Compose（`docker compose up -d`）。

> 注意：容器镜像（`node:20-alpine`）未内置 Chromium，Bing 的 Playwright 模式不可用。容器内建议 `-e DEFAULT_SEARCH_ENGINE=duckduckgo`。

## CLI 与本地 daemon

CLI 适合一次性执行；本地 daemon 是常驻 HTTP 服务，适合反复调用。

```bash
# 构建（本地源码时）
npm run build

# 启动 daemon
open-websearch serve

# 查看状态
open-websearch status --json

# 一次性搜索
open-websearch search "open web search" --limit 5 --json

# 结果不足 8 条时自动用其他引擎补位
open-websearch search "open web search" --min-results 8 --json

# 清空搜索 TTL 缓存（引擎刚恢复时用）
open-websearch cache-clear
```

daemon HTTP API（`GET /health`、`POST /search`、`POST /fetch-*`、`POST /cache/clear`）详见 [docs/http-api.md](docs/http-api.md)。

## 工具说明

MCP 共提供 7 个工具：

| 工具 | 用途 |
|------|------|
| `search` | 多引擎搜索，返回去重融合结果；支持 `engines`、`limit`、`searchMode`、`minResults` |
| `fetchCsdnArticle` | 抓取 CSDN 文章全文 |
| `fetchGithubReadme` | 抓取 GitHub 仓库 README |
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
  "url": "https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md",
  "maxChars": 12000
}
```

长文档用返回的 `nextStartIndex` 作为下一次调用的 `startIndex` 继续读取。

## 使用限制

- 搜索引擎为免费接口，可能遇到反爬/限流；Bing 最常见。应对：多引擎分担（`engines`）、`minResults` 级联、`BING_PLAYWRIGHT_FALLBACK=false`、或设置代理
- 依赖浏览器 cookie / JS 渲染的页面，需安装 Playwright 才能兜底抓取
- 国内网络下 GitHub 相关域名可能无法直接解析，可用 `fetchWebContent` + jsDelivr 镜像（`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/README.md`）

## 相关链接

- GitHub 上游：https://github.com/Aas-ee/open-webSearch
- HTTP API 文档：[docs/http-api.md](docs/http-api.md)
- 使用 skill 与 agent 工作流：仓库内 `skills/open-websearch/` 提供 `open-websearch` skill（`npx skills add` 安装），可引导 agent 执行搜索、抓取与多步分析
