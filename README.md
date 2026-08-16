<div align="center">

# MyWebSearch

**[🇨🇳 中文](./README-zh.md) | 🇺🇸 English**

![npm version](https://img.shields.io/npm/v/my-websearch)
![npm downloads](https://img.shields.io/npm/dm/my-websearch)
![license](https://img.shields.io/npm/l/my-websearch)
![GitHub stars](https://img.shields.io/github/stars/wtznicy/my-websearch)

</div>

`my-websearch` provides an MCP server, CLI, and local daemon, and can also be paired with skill-guided agent workflows for live web search and content retrieval without API keys.


## Features

- Web search using multi-engine results
    - Domestic engines (no proxy needed): bing, baidu, csdn, juejin, sogou
    - Overseas engines (⚠️ **proxy required in mainland China**): duckduckgo, exa, brave, startpage
- HTTP proxy configuration support for accessing restricted resources
- No API keys or authentication required
- Returns structured results with titles, URLs, and descriptions
- Configurable number of results per search
- Customizable default search engine
- Support for fetching individual article content
    - csdn
    - github (README files)
    - generic HTTP(S) page / Markdown content

## Choose the Right Path

- `MCP`
  - Best when you want to connect `my-websearch` to Claude Desktop, Cherry Studio, Cursor, or another MCP client.
- `CLI`
  - Best for one-shot local commands, shell scripts, and direct terminal usage.
- `Local daemon`
  - Best when you want a reusable long-lived local HTTP service exposing `status`, `GET /health`, and `POST /search` / `POST /fetch-*`. Start it explicitly with `my-websearch serve` and check it with `my-websearch status`.
- `Skill`
  - Best as an agent-facing guidance layer for setup and usage. A skill does not replace MCP, CLI, or the local daemon; it typically works together with the CLI and/or local daemon to help an agent discover, activate, and use the smallest working path.

## Use with a Skill

Install the `my-websearch` skill for your agent first:

```bash
npx skills add https://gitee.com/wtznicy/my-websearch --skill my-websearch
```

On first use, the skill typically follows this path: detect whether a usable `my-websearch` path already exists, guide setup/enablement if it does not, validate that the capability is active, and only then continue with search or fetch through the smallest working path.

If the current environment cannot complete setup or activation automatically, you can explicitly have the agent start the local daemon first:

```bash
my-websearch serve
my-websearch status
```

Keep installation proxy settings separate from runtime proxy settings:

- Installation proxy / mirror
  - Use this when the skill or agent is installing `my-websearch`, `playwright`, or other npm packages.
  - In restricted networks, npm-specific flags or npm config often work better than generic shell proxy variables, for example:

```bash
npm --proxy http://127.0.0.1:7890 --https-proxy http://127.0.0.1:7890 install -g my-websearch
```

- Runtime proxy
  - Use this when the daemon is already installed and is about to perform live `search` / `fetch` work.
  - This affects the `my-websearch` network traffic after `serve` starts, for example:

```bash
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 my-websearch serve
```

If the agent can only get through the package-install step with npm proxy settings, but live search/fetch also needs a proxy after startup, those are two separate configuration steps and should be handled separately.

## CLI and Local Daemon

CLI is for one-shot execution. The local daemon is a long-lived local HTTP service for repeated calls with lower startup friction. Use `my-websearch serve` as the explicit daemon start command and `my-websearch status` as the explicit daemon status command.

Action commands such as `search` and `fetch-web` try the default local daemon first when it is available. If you pass `--daemon-url`, that daemon path becomes explicit and silent fallback to direct execution is disabled.

Build first:

```bash
npm run build
```

Start the local daemon:

```bash
npm run serve
# globally installed: my-websearch serve
```

Check status:

```bash
npm run status -- --json
# globally installed: my-websearch status --json
```

Run a one-shot local CLI search:

```bash
npm run search:cli -- "open web search" --json
```

Notes:
- Bare `my-websearch` is the MCP server compatibility entrypoint, not the recommended daemon start command for agent automation.
- For content extraction, prefer searching first and then fetching a more specific result page. Some homepages and JS-heavy landing pages may not expose readable article text through `fetch-web`.
- `--min-results N` on `search` auto-runs additional engines (not already requested) until at least N results come back; defaults to off.
- Bing's HTTP mode is the most anti-bot-prone engine. If you hit verification pages often: (a) spread load with `engines: ["duckduckgo", "brave"]` on Bing-unrelated queries, or (b) set `BING_PLAYWRIGHT_FALLBACK=false` plus `--min-results` so a blocked Bing automatically cascades to lighter engines instead of launching a Playwright browser.
- `cache-clear` clears the in-memory search TTL cache — useful after an engine recovers from an outage or when a stale anti-bot page got cached:
  ```bash
  my-websearch cache-clear
  ```

For the local daemon HTTP API (`serve`, `status`, `GET /health`, `POST /search`, `POST /fetch-*`, `POST /cache/clear`), see [docs/http-api.md](docs/http-api.md).

## Installation Guide

If you are using `my-websearch` as an MCP server, continue with the MCP-oriented setup below.

### NPX Quick Start (Recommended)

The fastest way to get started:

```bash
# Basic usage
npx my-websearch@latest

# With environment variables (Linux/macOS)
DEFAULT_SEARCH_ENGINE=bing ENABLE_CORS=true npx my-websearch@latest

# Windows PowerShell
$env:DEFAULT_SEARCH_ENGINE="bing"; $env:ENABLE_CORS="true"; npx my-websearch@latest

# Windows CMD
set MODE=stdio && set DEFAULT_SEARCH_ENGINE=bing && npx my-websearch@latest

# Cross-platform (requires cross-env, Used for local development)
npm install -g my-websearch
npx cross-env DEFAULT_SEARCH_ENGINE=bing ENABLE_CORS=true my-websearch
```

**Environment Variables:**

| Variable | Default                 | Options | Description |
|----------|-------------------------|---------|-------------|
| `ENABLE_CORS` | `false`                 | `true`, `false` | Enable CORS |
| `CORS_ORIGIN` | `*`                     | Any valid origin | CORS origin configuration |
| `DEFAULT_SEARCH_ENGINE` | `bing`                  | `bing`, `duckduckgo`, `exa`, `brave`, `baidu`, `csdn`, `juejin`, `startpage`, `sogou` | Default search engine |
| `USE_PROXY` | `false`                 | `true`, `false` | Enable HTTP proxy |
| `PROXY_URL` | `http://127.0.0.1:7890` | Any valid URL | Proxy server URL |
| `PROXY_ENGINES` | empty (all engines) | Comma-separated engine names | With `USE_PROXY=true`, **only** the engines in this whitelist route through the proxy; others stay direct. Empty = all engines proxied (legacy global behavior). Recommended for mainland China: `PROXY_ENGINES=duckduckgo,exa,brave,startpage` (overseas engines via proxy, domestic engines direct) |
| `FAKE_IP_CIDRS` | empty | Comma-separated CIDR list | Treat DNS answers in these CIDRs as synthetic fake-IP results and do not block them as private-network DNS answers. Literal private/local targets and other private-network DNS answers remain blocked |
| `FETCH_WEB_INSECURE_TLS` | `false` | `true`, `false` | Disable TLS certificate verification for `fetchWebContent` only. Use only when a target site has a broken certificate chain |
| `MODE` | `both`                  | `both`, `http`, `stdio` | Server mode: both HTTP+STDIO, HTTP only, or STDIO only |
| `PORT` | `3211`                  | 1-65535 | Server port (MCP HTTP/S; CLI daemon uses 3210 by default) |
| `ALLOWED_SEARCH_ENGINES` | empty (all available) | Comma-separated engine names | Limit which search engines can be used; if the default engine is not in this list, the first allowed engine becomes the default |
| `SEARCH_MODE` | `auto` | `request`, `auto`, `playwright` | Search strategy. Currently only affects Bing: request only, request then Playwright fallback, or force Playwright |
| `BING_IMPERSONATE_TARGET` | `chrome131` | Any curl-cffi-node impersonate target (e.g. `chrome131`, `chrome124`, `chrome116`) | Browser fingerprint target for Bing's HTTP mode. Bing soft-degrades pure-HTTP requests by TLS/HTTP2 fingerprint; this enables Chrome fingerprint impersonation (2/3 requests return full results vs stable degradation otherwise). Fallback to the default HTTP client is automatic if the native module is unavailable |
| `BING_PLAYWRIGHT_FALLBACK` | `true` | `true`, `false` | In auto mode, when Bing's request mode hits an anti-bot page: `true` = launch a Playwright browser (slow, ~400MB); `false` = surface the error so the search service can cascade to lighter engines (e.g. duckduckgo/brave) via `minResults` |
| `PLAYWRIGHT_PACKAGE` | `auto` | `auto`, `playwright`, `playwright-core` | Which Playwright client package to resolve when browser mode is enabled |
| `PLAYWRIGHT_MODULE_PATH` | empty | Absolute path or project-relative path | Reuse an existing Playwright client package outside this project |
| `PLAYWRIGHT_EXECUTABLE_PATH` | empty | Any valid browser binary path | Launch an existing Chromium/Chrome executable without installing bundled browsers |
| `PLAYWRIGHT_WS_ENDPOINT` | empty | Valid Playwright `ws://` / `wss://` endpoint | Connect to an existing remote Playwright browser server |
| `PLAYWRIGHT_CDP_ENDPOINT` | empty | Valid Chromium CDP endpoint | Connect to an existing Chromium instance over CDP |
| `PLAYWRIGHT_HEADLESS` | `true` | `true`, `false` | Whether Playwright Chromium runs in headless mode |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | `20000` | Positive integer | Timeout for Playwright navigation and Bing result waits |
| `MCP_TOOL_SEARCH_NAME` | `search` | Valid MCP tool name | Custom name for the search tool |
| `MCP_TOOL_FETCH_CSDN_NAME` | `fetchCsdnArticle` | Valid MCP tool name | Custom name for the CSDN article fetch tool |
| `MCP_TOOL_FETCH_GITHUB_NAME` | `fetchGithubReadme` | Valid MCP tool name | Custom name for the GitHub README fetch tool |
| `MCP_TOOL_FETCH_JUEJIN_NAME` | `fetchJuejinArticle` | Valid MCP tool name | Custom name for the Juejin article fetch tool |
| `MCP_TOOL_FETCH_WEB_NAME` | `fetchWebContent` | Valid MCP tool name | Custom name for generic web/Markdown fetch tool |
| `EXA_API_KEY` | empty | Any valid Exa API key | **可选**（仅 exa 引擎需要）。exa 的免 key 网页端点已失效，想用 exa 引擎时在 [https://dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) 免费申请并配置到 MCP 客户端 env；不配置只影响 exa 一个引擎，其余引擎不受影响 |
| `LOG_LEVEL` | `normal` | `normal`, `quiet` | `quiet` 抑制启动配置日志（MCP stdio 裸启动默认已静默；诊断时可用 `LOG_LEVEL=normal` 恢复） |
| `OPEN_WEBSEARCH_QUIET_STARTUP` | `false` | `true`, `false` | 抑制启动配置日志（兼容开关，`LOG_LEVEL=quiet` 与之等价） |

**Optional: configure EXA_API_KEY (only needed if you want to use the exa engine)**

`EXA_API_KEY` is **optional** — every other engine (bing, baidu, csdn, juejin, sogou, duckduckgo, brave, startpage) works without it. Only configure it if you want to use `exa`: its old keyless web endpoint has been shut down by upstream (returns 500), so exa needs a free key from [https://dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys), configured in your MCP client:

**Claude Desktop** (`claude_desktop_config.json`):
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

**Cherry Studio / VSCode (Claude Dev):** same `env` field, add `"EXA_API_KEY": "<your-key>"` to the server's environment variables.

**ZCode** (`~/.zcode/cli/config.json` → `mcp.servers`):
```json
"my-websearch": {
  "type": "stdio",
  "command": "D:/nodejs/node.exe",
  "args": ["D:/path/to/build/index.js"],
  "env": {
    "MODE": "stdio",
    "EXA_API_KEY": "<your-key>"
  }
}
```

**CLI one-shot (no config file needed):**
```bash
EXA_API_KEY=<your-key> my-websearch search "query" --engines exa
# Windows PowerShell:
# $env:EXA_API_KEY="<your-key>"; my-websearch search "query" --engines exa
```

If the key is missing, the exa engine fails fast with an error message that includes these instructions instead of silently returning nothing.

**Common configurations:**
```bash
# Enable proxy for restricted regions
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 npx my-websearch@latest

# Only if a target website has a broken certificate chain
FETCH_WEB_INSECURE_TLS=true npx my-websearch@latest

# Request first, then fallback to Playwright if available
SEARCH_MODE=auto npx my-websearch@latest

# Force request-only Bing search
SEARCH_MODE=request npx my-websearch@latest

# Full configuration
DEFAULT_SEARCH_ENGINE=bing ENABLE_CORS=true USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 PORT=8080 npx my-websearch@latest
```

**Proxy guidance for mainland China:**

`duckduckgo`, `exa`, `brave`, and `startpage` are overseas engines and **cannot be reached without a proxy from mainland China** — they will time out or return errors. Domestic engines (`bing`, `baidu`, `csdn`, `juejin`, `sogou`) work without a proxy.

Use `PROXY_ENGINES` to keep domestic engines on a fast direct connection while routing only the overseas engines through the proxy (avoiding the redirects/timeouts that a global proxy causes for Chinese engines):

```bash
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 PROXY_ENGINES=duckduckgo,exa,brave,startpage npx my-websearch@latest
```

If a search includes overseas engines but the proxy is off, those engines will fail fast instead of hanging until timeout: my-websearch probes direct connectivity to `duckduckgo`/`brave`/`startpage` (3s timeout, one retry, result cached for 5 minutes) — unreachable engines immediately return a "proxy required, or use domestic engines" error, while reachable engines (e.g. overseas users) work normally. `exa` is excluded from probing because `api.exa.ai` is directly reachable from mainland China. When the proxy is on, engines in `PROXY_ENGINES` are never probed — they go straight through the proxy.

Browser-enhanced Bing fallback is opt-in. The published package does not bundle Playwright anymore. Enable it manually with one of these setups:

1. Full local Playwright install:
```bash
npm install playwright
npx playwright install chromium
SEARCH_MODE=auto npx my-websearch@latest
```

2. Reuse an existing browser binary with a slim client:
```bash
npm install playwright-core
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium SEARCH_MODE=auto npx my-websearch@latest
```

3. Reuse a Playwright package that already exists elsewhere on the machine:
```bash
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/node_modules/playwright SEARCH_MODE=playwright npx my-websearch@latest
```

4. Connect to an existing remote browser:
```bash
npm install playwright-core
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_WS_ENDPOINT=ws://127.0.0.1:3000/ SEARCH_MODE=auto npx my-websearch@latest
```

5. Reuse a local Chrome/Chromium session over CDP:
```bash
npm install playwright-core

# Start Chrome/Chromium with a debugging port first
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/my-websearch-chrome

# Then connect through CDP
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_CDP_ENDPOINT=http://127.0.0.1:9222 SEARCH_MODE=auto npx my-websearch@latest
```
This is the most practical setup when you want to reuse your own logged-in or previously verified browser session.

Windows PowerShell example:
```powershell
npm install playwright-core

& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\my-websearch-chrome"

$env:PLAYWRIGHT_PACKAGE="playwright-core"
$env:PLAYWRIGHT_CDP_ENDPOINT="http://127.0.0.1:9222"
$env:SEARCH_MODE="auto"
npx my-websearch@latest
```

Mode behavior:
- `request`: only uses request-based Bing scraping
- `auto`: tries request first, and only falls back to Playwright when request fails and a manually accessible Playwright client + browser are available
- `playwright`: forces Playwright and errors if the configured Playwright client or browser target is unavailable

Notes:
- `PLAYWRIGHT_MODULE_PATH` takes precedence over `PLAYWRIGHT_PACKAGE`
- `PLAYWRIGHT_WS_ENDPOINT` takes precedence over `PLAYWRIGHT_CDP_ENDPOINT`
- Remote endpoints ignore `PLAYWRIGHT_EXECUTABLE_PATH` and local proxy launch flags
- When Playwright is available, blocked CSDN/Zhihu article fetches and generic web fetches can also retry with browser-acquired cookies
- Without Playwright, `fetchWebContent` stays on the request-only path. Public pages can still work, but pages that require browser cookies or browser-rendered HTML may fail.

### Local Installation

1. Clone or download this repository
2. Install dependencies:
```bash
npm install
```
   This installs the core MCP server only. Browser fallback remains optional until you install or connect a Playwright client yourself.
3. Build the server:
```bash
npm run build
```
4. Add the server to your MCP configuration:

**Cherry Studio:**
```json
{
  "mcpServers": {
    "web-search": {
      "name": "Web Search MCP",
      "type": "streamableHttp",
      "description": "Multi-engine web search with article fetching",
      "isActive": true,
      "baseUrl": "http://localhost:3211/mcp"
    }
  }
}
```

**VSCode (Claude Dev Extension):**
```json
{
  "mcpServers": {
    "web-search": {
      "transport": {
        "type": "streamableHttp",
        "url": "http://localhost:3211/mcp"
      }
    },
    "web-search-sse": {
      "transport": {
        "type": "sse",
        "url": "http://localhost:3211/sse"
      }
    }
  }
}
```

**Claude Desktop:**
```json
{
  "mcpServers": {
    "web-search": {
      "type": "http",
      "url": "http://localhost:3211/mcp"
    },
    "web-search-sse": {
      "type": "sse",
      "url": "http://localhost:3211/sse"
    }
  }
}
```

**NPX Command Line Configuration:**
```json
{
  "mcpServers": {
    "web-search": {
      "args": [
        "my-websearch@latest"
      ],
      "command": "npx",
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "bing",
        "ALLOWED_SEARCH_ENGINES": "bing,duckduckgo,exa"
      }
    }
  }
}
```

Windows NPX configuration:
```json
{
  "mcpServers": {
    "web-search": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "my-websearch@latest"
      ],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "bing",
        "SYSTEMROOT": "C:/Windows"
      }
    }
  }
}
```

Proxy and TLS notes:
- my-websearch now disables Axios environment-proxy auto-detection internally and only uses the explicit `USE_PROXY` + `PROXY_URL` path.
- When `USE_PROXY=true`, all Axios-based network requests follow the configured `PROXY_URL` path instead of mixing direct requests with environment-proxy behavior.
- If `PROXY_URL` points to a local rule-based proxy client, that client can still decide which destinations go `DIRECT` and which ones are proxied.
- If `PROXY_URL` points to a fixed upstream proxy or overseas egress, region-sensitive sites such as Baidu, CSDN, Juejin, or GitHub may behave differently than before.
- If your host machine already sets `HTTP_PROXY` or `HTTPS_PROXY`, they will no longer override the server's internal request behavior.
- Prefer configuring `NODE_EXTRA_CA_CERTS` on Windows when a site has a missing intermediate CA.
- Use `FETCH_WEB_INSECURE_TLS=true` only as a last resort for `fetchWebContent`, since it weakens TLS verification.

**Local STDIO Configuration for Cherry Studio (Windows):**
```json
{
  "mcpServers": {
    "my-websearch-local": {
      "command": "node",
      "args": ["C:/path/to/your/project/build/index.js"],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "bing",
        "ALLOWED_SEARCH_ENGINES": "bing,duckduckgo,exa"
      }
    }
  }
}
```

## Usage Guide

The server provides seven tools: `search`, `resolveLibraryId`, `queryDocs`, `fetchCsdnArticle`, `fetchGithubReadme`, `fetchJuejinArticle`, and `fetchWebContent`.

For the local daemon HTTP API (`serve`, `status`, `GET /health`, `POST /search`, `POST /fetch-*`), see [docs/http-api.md](docs/http-api.md).

### search Tool Usage

```typescript
{
  "query": string,        // Search query
  "limit": number,        // Optional: Number of results to return (default: 10)
  "engines": string[],    // Optional: Engines to use (bing,baidu,csdn,duckduckgo,exa,brave,juejin,startpage,sogou) default runtime-configured engine. Note: duckduckgo/exa/brave/startpage need a proxy from mainland China (see PROXY_ENGINES)
  "searchMode": string    // Optional: request, auto, or playwright (currently only affects Bing)
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "search",
  arguments: {
    query: "search content",
    limit: 3,  // Optional parameter
    engines: ["bing", "csdn", "duckduckgo", "exa", "brave", "juejin", "sogou"] // Optional parameter, supports multi-engine combined search
  }
})
```

Response example:
```json
[
  {
    "title": "Example Search Result",
    "url": "https://example.com",
    "description": "Description text of the search result...",
    "source": "Source",
    "engine": "Engine used"
  }
]
```

### fetchCsdnArticle Tool Usage

Used to fetch complete content of CSDN blog articles.

```typescript
{
  "url": string    // URL from CSDN search results using the search tool
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchCsdnArticle",
  arguments: {
    url: "https://blog.csdn.net/xxx/article/details/xxx"
  }
})
```

Response example:
```json
[
  {
    "content": "Example search result"
  }
]
```

### fetchGithubReadme Tool Usage

Used to fetch README content from GitHub or Gitee repositories (Gitee uses the official API, reachable without a proxy).

```typescript
{
  "url": string    // GitHub/Gitee repository URL (supports HTTPS, SSH formats)
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchGithubReadme",
  arguments: {
    url: "https://gitee.com/wtznicy/my-websearch"
  }
})
```

Supported URL formats:
- GitHub HTTPS: `https://github.com/owner/repo`
- GitHub HTTPS with .git: `https://github.com/owner/repo.git`
- GitHub SSH: `git@github.com:owner/repo.git`
- URLs with parameters: `https://github.com/owner/repo?tab=readme`
- Gitee HTTPS: `https://gitee.com/owner/repo`
- Gitee SSH: `git@gitee.com:owner/repo.git`

Response example:
```json
[
  {
    "content": "<div align=\"center\">\n\n# MyWebSearch MCP Server..."
  }
]
```

### fetchWebContent Tool Usage

Fetch content directly from public HTTP(S) links, including Markdown files (`.md`) and ordinary web pages.

```typescript
{
  "url": string,         // Public HTTP(S) URL
  "maxChars": number     // Optional: max returned content length (1000-200000, default 30000)
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchWebContent",
  arguments: {
    url: "https://gitee.com/wtznicy/my-websearch/raw/main/README.md",
    maxChars: 12000
  }
})
```

Response example:
```json
{
  "url": "https://gitee.com/wtznicy/my-websearch/raw/main/README.md",
  "finalUrl": "https://gitee.com/wtznicy/my-websearch/raw/main/README.md",
  "contentType": "text/plain; charset=utf-8",
  "title": "",
  "truncated": false,
  "content": "# MyWebSearch MCP Server ..."
}
```

### fetchJuejinArticle Tool Usage

Used to fetch complete content of Juejin articles.

```typescript
{
  "url": string    // Juejin article URL from search results
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchJuejinArticle",
  arguments: {
    url: "https://juejin.cn/post/7520959840199360563"
  }
})
```

Supported URL format:
- `https://juejin.cn/post/{article_id}`

Response example:
```json
[
  {
    "content": "🚀 开源 AI 联网搜索工具：MyWebSearch MCP 全新升级，支持多引擎 + 流式响应..."
  }
]
```

## Usage Limitations

Since this tool works by scraping multi-engine search results, please note the following important limitations:

1. **Rate Limiting**:
    - Too many searches in a short time may cause the used engines to temporarily block requests
    - Recommendations:
        - Maintain reasonable search frequency
        - Use the limit parameter judiciously
        - Add delays between searches when necessary
    - **Brave is the strictest**: it throttles consecutive automated requests aggressively — a burst of searches triggers HTTP 429 for minutes (even from residential proxy IPs), and the block window outlasts short cooldowns. Use brave at low frequency; prefer `duckduckgo` / `startpage` as the daily overseas engines (they are stable and of similar quality). A 429 on brave fails fast and `minResults` cascade automatically falls back to other engines.

2. **Result Accuracy**:
    - Depends on the HTML structure of corresponding engines, may fail when engines update
    - Some results may lack metadata like descriptions
    - Complex search operators may not work as expected

3. **Legal Terms**:
    - This tool is for personal use only
    - Please comply with the terms of service of corresponding engines
    - Implement appropriate rate limiting based on your actual use case

4. **Search Engine Configuration**:
   - Default search engine can be set via the `DEFAULT_SEARCH_ENGINE` environment variable
   - Supported engines: bing, duckduckgo, exa, brave, baidu, csdn, juejin, startpage, sogou
   - Overseas engines (duckduckgo, exa, brave, startpage) require a proxy from mainland China (see `PROXY_ENGINES`); domestic engines (bing, baidu, csdn, juejin, sogou) work direct
   - The default engine is used when searching specific websites

5. **Proxy Configuration**:
   - HTTP proxy can be configured when certain search engines are unavailable in specific regions
   - Enable proxy with environment variable `USE_PROXY=true`
   - Configure proxy server address with `PROXY_URL`
   - With `USE_PROXY=true`, `PROXY_ENGINES` (comma-separated whitelist) limits which engines route through the proxy; empty = all engines proxied. Overseas engines (`duckduckgo`, `exa`, `brave`, `startpage`) require a proxy from mainland China, while domestic engines stay direct — recommended: `PROXY_ENGINES=duckduckgo,exa,brave,startpage`
   - For Clash fake-ip / TUN setups, configure synthetic DNS ranges with `FAKE_IP_CIDRS` (for example `198.18.0.0/15`)

## Contributing

Welcome to submit issue reports and feature improvement suggestions!

### resolveLibraryId Tool Usage

Resolves a library/package name into a Context7-compatible library ID, with reputation and quality metadata. Powered by the [Context7](https://context7.com) documentation index — official, version-specific library docs without needing a separate MCP server.

```typescript
{
  "libraryName": string,  // e.g. "Next.js", "express", "prisma"
  "query": string,        // The user's question, used to rank matches (e.g. "how to implement authentication")
  "limit": number         // Optional: max matches (default 5, max 10)
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "resolveLibraryId",
  arguments: {
    libraryName: "Next.js",
    query: "how to set up middleware with auth"
  }
})
```

### queryDocs Tool Usage

Retrieves up-to-date, version-specific documentation snippets and code examples for a library. Use `resolveLibraryId` first if you don't know the library ID.

```typescript
{
  "libraryId": string,  // Context7-compatible ID, e.g. "/vercel/next.js", "/packages/express" (optional version: "/vercel/next.js@v15.1.8")
  "query": string,      // The question or task to get relevant documentation for
  "limit": number       // Optional: max code snippets (default 5, max 10)
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "queryDocs",
  arguments: {
    libraryId: "/vercel/next.js",
    query: "how to set up middleware with authentication"
  }
})
```

> **Note:** Both Context7 tools call the public REST API directly (no API key required at low rate limits). Set `CONTEXT7_API_KEY` for higher rate limits.

## Author & Acknowledgements

**Author: wtznicy**

This project is a modified fork of **Open-WebSearch** (originally by Aas-ee) — thanks to the original author for the great work.

Thanks also to these open-source projects:
- **context7** (Upstash): powers the `resolveLibraryId` / `queryDocs` library-docs lookup
- **fetch** (official MCP servers): reference for the `fetchWebContent` web-fetching design
