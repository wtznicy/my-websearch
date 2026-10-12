<div align="center">

# 🔍 MyWebSearch

**Keyless Multi-Engine AI Web Search & High-Purity Content Extraction Engine**  
*MCP Server · CLI · Local HTTP Daemon · Skill-Guided Agent Workflows*

**[🇨🇳 简体中文](./README-zh.md) | [🇺🇸 English](./README.md)**

[![npm version](https://img.shields.io/npm/v/my-websearch?style=flat-square&color=3178c6)](https://www.npmjs.com/package/my-websearch)
[![npm downloads](https://img.shields.io/npm/dm/my-websearch?style=flat-square&color=2ea44f)](https://www.npmjs.com/package/my-websearch)
[![license](https://img.shields.io/npm/l/my-websearch?style=flat-square&color=grey)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/wtznicy/my-websearch?style=flat-square&color=e3b341)](https://github.com/wtznicy/my-websearch)
[![M8ven Live Monitored](https://m8ven.ai/badge/mcp/wtznicy-my-websearch-1nmaw4)](https://m8ven.ai/mcp/wtznicy-my-websearch-1nmaw4)

</div>

---

## ✨ Features

`my-websearch` is a full-stack search and technical documentation engine built specifically for AI coding agents (**Claude Desktop, Cursor, Cherry Studio, Windsurf, Cline, ZCode**, etc.). It requires **zero paid API keys**:

- 🌐 **9-Engine Federated Search & Smart Routing**  
  Aggregates direct domestic engines (**Bing, Baidu, CSDN, Juejin, Sogou**) and global engines (**DuckDuckGo, Brave, Startpage, Exa**). Features automatic language-aware routing (`auto`), parallel multi-query execution (`queries: string[]`), URL deduplication, and automatic `minResults` cascading fallback.
- ⚡ **Native Anti-Bot & Proof-of-Work Solvers (Zero-Browser Fast Path)**  
  Built on `wreq-js` with native Chrome TLS/HTTP2 handshake emulation and persistent session cookies. Includes pure-JS/Rust solvers for **Startpage's Anubis SHA-256 PoW challenge** and **DuckDuckGo's `d.js` (`isJsaChallenge`) HTML5/arithmetic challenge**, bypassing anti-bot walls in milliseconds without launching a 400MB browser. Real URL decryption for Sogou (`uigs_para`), Baidu `Location`, and Bing Base64 links.
- 📄 **High-Purity Markdown Article Extraction**  
  Combines Mozilla Readability with intelligent chrome noise stripping. Removes `<nav>`, `<aside>`, `<footer>`, and breadcrumbs while faithfully preserving article titles (`<article><header><h1>`), code blocks, and GFM tables. Supports seamless pagination (`startIndex`).
- 📚 **Official Context7 Library Docs Lookup**  
  Integrated `resolveLibraryId` and `queryDocs` allow searching version-pinned official documentation and code examples without hosting a separate Context7 server. Features automatic HTTP 301 canonical ID tracking and runtime quota fallback.
- 🌏 **Zero-Config Network Detection & Clash Fake-IP Ready**  
  Auto-detects OS system proxies (Windows Registry / macOS scutil / Linux env). Automatically routes overseas engines through proxy while keeping domestic engines on fast direct lines. Pre-whitelists `198.18.0.0/15` for Clash TUN / Fake-IP compatibility while enforcing strict SSRF security bounds.
- 🔌 **Versatile Deployment Modes**  
  Works seamlessly across **MCP STDIO** (Claude Desktop/Cursor), **Streamable HTTP / SSE** (Cherry Studio/remote clients), **CLI one-shot commands**, and a **Local HTTP Daemon** with connection pool reuse and Prometheus `/metrics` monitoring.

---

## 🏗️ Architecture

```mermaid
flowchart TB
    subgraph Clients["🤖 Entrypoints"]
        MCP["MCP Server<br/>(STDIO / Streamable HTTP / SSE)"]
        CLI["CLI Commands<br/>(my-websearch search / fetch-*)"]
        Daemon["Local Daemon<br/>(127.0.0.1:3210 · /health · /metrics)"]
    end

    subgraph Core["🧠 Search & Fetch Orchestrator"]
        Router["Language-Aware Auto Router<br/>ZH → Baidu/Sogou | EN/Tech → Bing + DuckDuckGo"]
        Cascade["minResults Cascade & Circuit Breaker<br/>(Auto Fallback + 5min TTL LRU Cache)"]
        Ranker["Cross-Engine URL Deduplication & BM25 Relevance Ranking"]
    end

    subgraph Transport["🛡️ Anti-Bot & Security Transport"]
        Wreq["wreq-js Chrome TLS/H2 Fingerprint<br/>+ Automatic Session Cookie Jars"]
        Solvers["Millisecond Challenge Solvers<br/>Startpage PoW | DDG JSA Solver"]
        PW["Playwright Stealth Browser Fallback<br/>(Budget Bounds + Cross-Process Locking)"]
        Guard["SSRF Guard & Clash Fake-IP Support<br/>(PROXY_ENGINES Split Routing + 198.18.0.0/15)"]
    end

    subgraph Engines["🌍 9 Search Engines + 6 Content/Docs Tools"]
        CN["🇨🇳 Direct Engines<br/>Bing · Baidu · CSDN · Juejin · Sogou"]
        INTL["🌐 Global Engines<br/>DuckDuckGo · Brave · Startpage · Exa"]
        Docs["📚 Content & Official Docs<br/>fetchWebContent · Context7 · GitHub/Gitee · CSDN/Juejin"]
    end

    Clients --> Core
    Core --> Transport
    Transport --> Engines
```

---

## 🌍 9 Search Engines

| Engine | Mainland China Connectivity | API Key | Core Technology | Best For |
| :--- | :---: | :---: | :--- | :--- |
| **`bing`** | 🇨🇳 Direct | None | Chrome TLS impersonation + Base64 real URL resolution + stealth fallback | General technical search, mixed EN/ZH queries |
| **`baidu`** | 🇨🇳 Direct | None | Concurrent `Location` redirect resolution + anti-bot detection | Chinese news, documentation, domestic forums |
| **`csdn`** | 🇨🇳 Direct | None | WAF cookie jar persistence + empty response auto-retry | Chinese error logs, debugging tutorials |
| **`juejin`** | 🇨🇳 Direct | None | Direct official API querying for clean long-form articles | Modern frontend/backend technical blogs |
| **`sogou`** | 🇨🇳 Direct | None | Desktop & mobile dual parsing + `uigs_para` token decoding + ad removal | WeChat ecosystem links & long-tail queries |
| **`duckduckgo`** | 🌐 Proxy in CN | None | Preload `d.js` + **built-in `isJsaChallenge` JS solver** | English technical search & open-source discussions |
| **`startpage`** | 🌐 Proxy in CN | None | **Built-in Anubis SHA-256 PoW solver** + cookie session (no browser needed) | Google-backed high-privacy results |
| **`brave`** | 🌐 Proxy in CN | None | Native TLS fingerprinting + strict sponsored ad stripping | Independent English index & technical blogs |
| **`exa`** | 🌐 Direct API | Optional Free Key | Official semantic search API (skipped if key is unset) | Semantic similarity, AI research & papers |

---

## 🛠️ 7 MCP Tools

| Tool Name | Purpose | Key Highlights |
| :--- | :--- | :--- |
| **`search`** | Multi-engine federated search | Supports `query` or parallel `queries: string[]`, `engines`, `limit`, and `minResults` cascading |
| **`fetchWebContent`** | Web page extraction & Markdown conversion | Supports `format: "markdown"`, title rescue, chrome noise stripping, and `startIndex` pagination |
| **`resolveLibraryId`** | Resolve package name to Context7 ID | Resolves `"Next.js"`, `"prisma"`, etc. with trust metadata; supports HTTP 301 redirection |
| **`queryDocs`** | Retrieve official library documentation | Fetches versioned API documentation and code snippets (e.g. `"/vercel/next.js@v15.1.8"`) |
| **`fetchGithubReadme`** | Fetch GitHub or Gitee repository README | Supports HTTPS/SSH URLs; **Gitee uses official API directly without proxy** |
| **`fetchCsdnArticle`** | Extract full CSDN blog article | Clean content extraction with automated cookie persistence |
| **`fetchJuejinArticle`** | Extract full Juejin blog article | Direct official API fetch; pass `format: "markdown"` for formatted code blocks and tables |

---

## 🚀 Quick Start

### 1. Run with NPX (Zero Configuration)

No installation required:

```bash
npx -y my-websearch@latest
```

> 💡 **Automated Proxy Discovery**: The server automatically detects your operating system's proxy settings. If a local proxy (Clash, v2ray, Surge) is active, overseas engines automatically use the proxy while domestic engines stay on fast direct lines. `198.18.0.0/15` is whitelisted out of the box for Clash Fake-IP.

### 2. Configure in AI Clients

#### 🔹 Claude Desktop / Cursor / Windsurf / Cline (STDIO Mode)

Add to your MCP settings file:

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

*(For Windows environments where `npx` is not in the system path, set `command` to `cmd` and `args` to `["/c", "npx", "-y", "my-websearch@latest"]`)*

#### 🔹 Cherry Studio (Streamable HTTP Mode)

Start the server in your terminal with `npx my-websearch@latest` (default port `3211`), then configure:

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

## 💻 CLI & Local Daemon

`my-websearch` can be used directly from your terminal as a standalone CLI tool or persistent daemon:

```bash
# Global install
npm install -g my-websearch

# Start persistent local HTTP daemon (port 3210 by default)
my-websearch serve

# One-shot terminal search (reuses running daemon automatically)
my-websearch search "Model Context Protocol best practices" --limit 5 --min-results 5 --json

# Extract web page as clean Markdown
my-websearch fetch-web "https://blog.vuejs.org/posts/vue-3-5" --max-chars 15000 --json

# View daemon status and Prometheus metrics (/health, /status, /metrics)
my-websearch status --json

# Clear in-memory search cache
my-websearch cache-clear
```

---

## ⚙️ Configuration & Environment Variables

### Global Configuration (`~/.my-websearch/config.json`)

To share settings across all MCP clients without duplicate configuration:

```json
{
  "apiKeys": {
    "context7": "ctx7sk-...",
    "exa": "..."
  },
  "proxy": {
    "url": "http://127.0.0.1:7897",
    "useProxy": false,
    "engines": ["duckduckgo", "exa", "brave", "startpage"]
  }
}
```

### 📋 Exhaustive Environment Variables Reference

Can be set via the global configuration file (`~/.my-websearch/config.json`), local `.env`, or system environment variables:

#### 1. 🔍 Search & Routing Orchestration

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `DEFAULT_SEARCH_ENGINE` | `auto` | Default engine: `auto` (smart query routing: Chinese `baidu,sogou`, English/foreign `bing,duckduckgo`), `bing`, `baidu`, `csdn`, `juejin`, `sogou`, `duckduckgo`, `brave`, `startpage`, `exa` |
| `ALLOWED_SEARCH_ENGINES` | all | Comma-separated whitelist of allowed search engines (e.g. `bing,baidu,duckduckgo`) |
| `BING_BASE_URL` | `https://cn.bing.com/search` | Base URL for Bing queries. Overseas users or reverse proxy nodes can set to `https://www.bing.com/search` (legacy alias `OPEN_WEBSEARCH_BING_HOST` supported) |
| `DEFAULT_MIN_RESULTS` | `5` | Cascade threshold: triggers fallback engines when usable results are fewer than this value |
| `DEFAULT_SEARCH_LIMIT` | `10` | Default result limit when not explicitly specified in tool calls (max 50) |
| `SEARCH_DEADLINE_MS` | `30000` | Global hard deadline for multi-engine search execution (milliseconds) |
| `SEARCH_AUTHORITY_DOMAINS` | empty | Additional authority domain whitelist for result re-ranking (comma-separated, appended to built-in list) |
| `SEARCH_MODE` | `auto` | Search mode and browser policy. Supports single mode, multi-engine per mode, and compound multi-mode combinations:<br/>• **Global mode**: `auto` (default fallback), `request`/`none` (pure HTTP), `playwright` (force browser)<br/>• **Single mode, multiple engines**: `playwright:bing,startpage`, `auto:bing,startpage`, `bing,startpage`<br/>• **Compound multiple modes**: `playwright:bing;auto:startpage` (bing forces browser, startpage uses auto fallback), `auto;request:startpage` (global auto but startpage uses pure HTTP) |

#### 2. 🌐 Proxy & Network Security

| Variable | Default | Allowed Values / Description |
| `PROXY_URL` | empty (off) | Consolidated upstream proxy configuration (merges previous `USE_PROXY` and `PROXY_ENGINES`). Not needed in TUN mode.<br/>• **Default proxy**: passing empty `PROXY_URL=""` or `PROXY_URL=true` activates default `http://127.0.0.1:7897` (common port for Clash Verge; use `10809` for v2rayN or `7890` for legacy Clash; overseas engines use proxy, domestic engines stay direct)<br/>• **Custom address**: `PROXY_URL=http://127.0.0.1:10809`<br/>• **Custom engines**: `PROXY_URL="http://127.0.0.1:7897;duckduckgo,brave"` or all engines `PROXY_URL=";all"` |
| `FAKE_IP_CIDRS` | `198.18.0.0/15` | Whitelisted CIDRs for Clash Fake-IP mode to avoid SSRF false-positive blocking |
| `IMPERSONATE_BROWSER` | `chrome_149` | `wreq-js` browser TLS/H2 fingerprint profile (e.g. `chrome_149`, `safari_18`) |
| `IMPERSONATE_OS` | `windows` | Operating system platform for fingerprint impersonation (`windows`, `macos`, `linux`) |
| `FETCH_WEB_INSECURE_TLS`| `false` | Disable TLS certificate verification for `fetchWebContent` only (for broken legacy site certs) |
| `GITHUB_README_CDN_FIRST` | `false` | When `true`, forces skipping `raw.githubusercontent.com` direct probe and queries jsDelivr CDN first (domestic network acceleration) |

#### 3. 🔐 Credentials & API Keys

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `CONTEXT7_API_KEY` | empty | [Context7 API Key](https://context7.com/dashboard) (strongly recommended for proxy/TUN users to bypass shared IP quotas) |
| `EXA_API_KEY` | empty | [Exa Free API Key](https://dashboard.exa.ai/api-keys) (only required if using the `exa` semantic search engine) |
| `GITHUB_TOKEN` | empty | GitHub Personal Access Token (raises rate limit for `fetchGithubReadme` to avoid 403s) |

#### 4. 🖥️ Server Modes, Concurrency & Session Reaper

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `MODE` | `both` | MCP transport mode: `stdio` (stdin/stdout only), `http` (HTTP/SSE only), `both` (concurrent) |
| `PORT` | `3211` | MCP HTTP/SSE listen port (local persistent daemon uses `3210` by default) |
| `MAX_CONCURRENT_SEARCHES`| `20` | Max concurrent searches in daemon mode (`0` for unlimited) |
| `MCP_MAX_SESSIONS` | `100` | Max retained MCP HTTP sessions before returning HTTP 429 Too Many Requests |
| `MCP_SESSION_TTL_MS` | `1800000` | Idle session expiration duration before reaping (default 30 min) |
| `MCP_SESSION_REAPER_MS` | `300000` | Session reaper scan interval (default 5 min) |
| `LOG_LEVEL` | `info` | Log level: `quiet` (completely silent), `debug`, `info`, `warn`, `error` |
| `SECURITY_AUDIT` | `false` | Enable SSRF blocking and host header security audit logging |
| `OPEN_WEBSEARCH_ALLOWED_HOSTS` | loopback | Host header whitelist for HTTP server (DNS Rebinding protection, comma-separated) |

#### 5. 🧭 Playwright Browser & Stealth Controls

> [!NOTE]
> `BING_PLAYWRIGHT_FALLBACK` and `STARTPAGE_PLAYWRIGHT_FALLBACK` have been consolidated into `SEARCH_MODE` (e.g. `SEARCH_MODE=bing` or `SEARCH_MODE=request`). Backward compatibility is automatically preserved.

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `PLAYWRIGHT_CDP_ENDPOINT` | empty | Remote Chrome/Edge CDP endpoint URL (e.g. `http://127.0.0.1:9222` or `ws://...`) |
| `PLAYWRIGHT_EXECUTABLE_PATH` | auto | Absolute path to browser executable (auto-detects system Edge/Chrome by default) |
| `PLAYWRIGHT_HEADLESS` | `true` | Run headless (on Windows, automatically utilizes an isolated hidden desktop window) |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS`| `20000` | Hard page navigation timeout for Playwright (milliseconds) |

#### 6. 🛠️ Application Directory & Tool Customization

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `MYWEBSEARCH_DATA_DIR` | `~/.my-websearch` | Root directory for configuration and persistent cookie files |
| `OPEN_WEBSEARCH_RESPONSE_CAP_BYTES`| `60000` | Maximum character limit returned to LLMs to prevent prompt context explosion |
| `MCP_TOOL_SEARCH_NAME` | `search` | Custom registration name for the search tool in MCP |
| `MCP_TOOL_FETCH_WEB_NAME` | `fetchWebContent` | Custom registration name for the content extraction tool |
| `MCP_TOOL_FETCH_GITHUB_NAME` | `fetchGithubReadme` | Custom registration name for the GitHub README tool |

> 💡 **Zero-Config Upgrades (Redundant Variables Removed)**:
> - **CORS Switches** (`ENABLE_CORS`/`CORS_ORIGIN`): HTTP mode now has **safe CORS (`*`) built-in by default**.
> - **Playwright Package Selection** (`PLAYWRIGHT_PACKAGE`/`PLAYWRIGHT_MODULE_PATH`): Now **100% automated** via intelligent client and system binary discovery.
> - **Remote Browser Endpoint** (`PLAYWRIGHT_WS_ENDPOINT`): Unified into standard `PLAYWRIGHT_CDP_ENDPOINT`.
> - **Emoji Switch** (`OPEN_WEBSEARCH_NO_EMOJI`): Automatic console code page detection smoothly falls back to ASCII tags on legacy terminals.
> - **Fragmented Debug Flag** (`OPEN_WEBSEARCH_DEBUG`): Unified into standard `LOG_LEVEL=debug`.
> - **Cookie Persistence TTL** (`MYWEBSEARCH_COOKIE_TTL_DAYS`): Solidified to 30 days with automated sliding renewal.

---

## 🤝 Contributing & Tests

Pull requests and issues are welcome! To run the test suite locally:

```bash
npm install
npm run build
npm test              # Run 255 Vitest unit tests (33 test suites, fast & deterministic)
npm run test:live     # Run bounded-concurrency live integration tests
npm run eval:live     # Run 22-case live STDIO JSON-RPC evaluation suite
```

### Acknowledgements

**Author: wtznicy**

This project evolved from **Open-WebSearch** (originally created by Aas-ee) — special thanks to the original author. Thanks also to:
- **[wreq-js](https://www.npmjs.com/package/wreq-js)** for native Chrome TLS/HTTP2 fingerprint impersonation
- **[Context7](https://context7.com)** for powering official documentation retrieval
- **[Mozilla Readability](https://github.com/mozilla/readability) & [Turndown](https://github.com/mixmark-io/turndown)** for content extraction and GFM Markdown formatting
