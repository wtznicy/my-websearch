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

> **One server, four ways to use it:** connect an AI client over MCP, run a one-shot CLI query, keep a local daemon alive, or use the built-in diagnostics before going live.

**Jump to:** [Quick start](#quick-start) · [MCP tools](#mcp-tools) · [CLI](#cli) · [Configuration](#configuration) · [Diagnostics](#diagnostics) · [Development](#development)

## ✨ Features

`my-websearch` is a full-stack search and technical documentation engine built specifically for AI coding agents (**Claude Desktop, Cursor, Cherry Studio, Windsurf, Cline, ZCode**, etc.). Out of the box, ready for multiple mainstream AI clients:

- 🌐 **13-Engine Federated Search & Smart Routing**  
  Aggregates direct domestic engines (**Bing, Baidu, CSDN, Juejin, Sogou**), global engines (**DuckDuckGo, Brave, Startpage, Exa**), and specialized developer platforms (**GitHub, StackOverflow, Hacker News, arXiv**). Features automatic language-aware routing (`auto`), parallel multi-query execution (`queries: string[]`), URL deduplication, and automatic `minResults` cascading fallback.
- ⚡ **Native Web Protocol & Proof-of-Work Solvers (Zero-Browser Fast Path)**  
  Built on `wreq-js` with native modern TLS/HTTP2 handshake emulation and persistent session cookies. Includes pure-JS/Rust solvers for **Startpage's Anubis SHA-256 PoW challenge** and **DuckDuckGo's `d.js` (`isJsaChallenge`) HTML5/arithmetic challenge**, resolving structured challenge responses in milliseconds without launching a 400MB browser. Real URL resolution for Sogou redirect links, Baidu `Location`, and Bing Base64 links.
- 📄 **High-Purity Markdown Article Extraction & Dedicated Site Purifiers**  
  Combines Mozilla Readability with intelligent chrome noise stripping. Features dedicated purification rules for **WeChat Official Accounts** (`mp.weixin.qq.com`), **StackOverflow questions & accepted answers**, and transparent internal routing for **CSDN & Juejin**. Removes `<nav>`, `<aside>`, `<footer>`, and breadcrumbs while faithfully preserving article titles, code blocks, and GFM tables. Supports seamless pagination (`startIndex`), plus three token-saving modes: **BM25 relevance-ranked `focus`**, **CSS-selector `extract` to JSON with no LLM**, and **numbered `citations`**.
- 📚 **Unified Context7 Library Docs Lookup (`queryDocs`)**  
  Directly query official documentation with natural package names (e.g. `"next.js"`, `"vue"`) or Context7 IDs without needing a separate resolve step. Includes automatic candidate ranking, blind-guess 404 self-healing, and related alternatives discovery.
- 🐙 **Extended GitHub / Gitee Resource Fetcher**  
  `fetchGithubContent` (formerly `fetchGithubReadme`) supports both GitHub and Gitee: repository READMEs, any source file (`/blob/...`), directory trees (`/tree/...`), and complete issue / PR discussions.
- 🌏 **Zero-Config Network Detection & Fake-IP Ready**  
  Auto-detects OS system proxies (Windows Registry / macOS scutil / Linux env). Automatically routes overseas engines through proxy while keeping domestic engines on fast direct lines. Pre-whitelists `198.18.0.0/15` for TUN / Fake-IP compatibility while enforcing strict SSRF security bounds.
  **No proxy is the supported default**: outside mainland China, leave `USE_PROXY` unset and every engine is queried directly — you don't need Clash/v2ray to use this server.
- 🔌 **Versatile Deployment Modes**  
  Works seamlessly across **MCP STDIO** (Claude Desktop/Cursor), **Streamable HTTP / SSE** (Cherry Studio/remote clients), **CLI one-shot commands**, and a **Local HTTP Daemon** with connection pool reuse and Prometheus `/metrics` monitoring.

---

## 🌍 14 Search Engines

| Engine | Mainland China Connectivity | API Key | Core Technology | Best For |
| :--- | :---: | :---: | :--- | :--- |
| **`bing`** | 🇨🇳 Direct | None | Chrome TLS impersonation + Base64 real URL resolution + stealth fallback | General technical search, mixed EN/ZH queries |
| **`baidu`** | 🇨🇳 Direct | None | Concurrent `Location` redirect resolution + challenge detection | Chinese news, documentation, domestic forums |
| **`csdn`** | 🇨🇳 Direct | None | WAF cookie jar persistence + empty response auto-retry | Chinese error logs, debugging tutorials |
| **`juejin`** | 🇨🇳 Direct | None | Direct official API querying for clean long-form articles | Modern frontend/backend technical blogs |
| **`sogou`** | 🇨🇳 Direct | None | Desktop & mobile dual parsing + redirect link decoding + ad removal | WeChat ecosystem links & long-tail queries |
| **`duckduckgo`** | 🌐 Proxy in CN | None | Preload `d.js` + **built-in `isJsaChallenge` JS solver** (HTTP 202 = exit-IP rate limit) | English technical search & open-source discussions |
| **`startpage`** | 🌐 Proxy in CN | None | **Multi-worker Anubis SHA-256 PoW solver** (difficulty ≤ 6) + cookie session (no browser needed) | Google-backed high-privacy results |
| **`brave`** | 🌐 Proxy in CN | None | Native TLS fingerprinting + strict sponsored ad stripping | Independent English index & technical blogs |
| **`exa`** | 🌐 Direct API | Optional Free Key | Official semantic search API (skipped if key is unset) | Semantic similarity, AI research & papers |
| **`github`** | 🌐 Proxy in CN | None | Official GitHub Search REST API + **exact owner/repo fast path** (issues & repositories) | GitHub issues, bug reports, repositories, and exact repo lookup |
| **`stackoverflow`**| 🌐 Proxy in CN | None | Official StackExchange 2.3 API with HTML entity decoding | Developer troubleshooting, stack traces & answers |
| **`hackernews`** | 🌐 Proxy in CN | None | Algolia HN Search API with points, comments & author metadata | Tech discussions, startup launches & engineering news |
| **`arxiv`** | 🌐 Proxy in CN | None | Official arXiv Atom XML API parsing titles, authors & abstracts | Scientific papers, machine learning & AI research |
| **`code`** | 🇨🇳 Direct | None | grep.app API search across global GitHub code with repo, path & exact line numbers | Source code implementations, API usage patterns |

---

<a id="mcp-tools"></a>

## 🛠️ 4 Core MCP Tools (Minimal & Token-Efficient)

> 💡 **Token Budget & Slimming**: All tool descriptions are strictly kept within 250 characters (total description characters ≤ 1000). Detailed routing guidance is delegated to `McpServer({ instructions })`, significantly reducing LLM context consumption.

| Tool Name | Purpose | Key Highlights |
| :--- | :--- | :--- |
| **`search`** | Federated web & code search (14 engines) | Supports parallel queries, `timeRange: day\|week\|month\|year` date filter, `site: string[]` filter, `fetchTop` preview injection, `code` engine (grep.app); explicit `engines` defaults to `minResults=0` (no unconstrained cascade); returns inline `diagnostics` on failure |
| **`fetchWebContent`** | Web page extraction, Markdown & transparent PDF parsing | **All-in-one content extractor**: Built-in disk-level Markdown cache (Node 22 `node:sqlite` / partitioned JSON fallback, 200MB LRU, `cache: default\|reload`); transparent PDF parsing (up to 20MB / 50 pages, `[page N]` tags, scanned doc detection); pagination & `focus` keyword targeting (**`bm25`** relevance-ranked blocks by default, `window` for the legacy fixed window); **`selector`** to scope extraction to a CSS subtree (errors instead of silently returning the whole page); **`extract`** for CSS-selector JSON with no LLM; **`citations`** for numbered references; **`retainLinks`** to strip URLs (-50% on index pages) |
| **`fetchGithubContent`** | Comprehensive GitHub / Gitee content reader | Fetches README, **one source file** (`/blob/<ref>/<path>`), directory trees (`/tree/`), and Issue / PR discussions; `ref` may be a branch, tag, or commit; not a repo clone; Gitee parity via API (file/tree/issue/PR, optional `GITEE_TOKEN`); returns `warnings` |
| **`queryDocs`** | All-in-one official library documentation | Directly resolves library names or Context7 IDs; includes low-confidence protection and automatic fallback chain (npm registry → PyPI JSON → GitHub README); returns `source: context7\|npm\|pypi\|github-readme`, `confidence`, and `warnings` |

> 💡 **Backward Compatibility**: Legacy `fetchCsdnArticle` and `fetchJuejinArticle` are automatically routed under `fetchWebContent`; legacy `resolveLibraryId` is merged into `queryDocs` (which accepts a `library` name or the legacy `libraryId` alias). The separate legacy tools were removed — the `REGISTER_LEGACY_ARTICLE_TOOLS` switch is gone, because keeping three unregistered handlers around still cost tool-description budget for nothing.

---

<a id="quick-start"></a>

## 🚀 Quick Start

### 1. Run with NPX (Zero Configuration)

No installation required:

```bash
npx -y my-websearch@latest
```

> 💡 **Automated Proxy Discovery**: The server automatically detects your operating system's proxy settings. If a local proxy environment is active, overseas engines automatically use the proxy while domestic engines stay on fast direct lines. `198.18.0.0/15` is whitelisted out of the box for Fake-IP environments.

### 2. Configure in AI Clients

#### 🔹 Automated setup (recommended)

`init` detects installed MCP clients, writes the server entry into their config files, and keeps a `.bak` backup:

```bash
npx -y my-websearch@latest init                      # auto-detect and write
npx -y my-websearch@latest init --dry-run            # preview the diff, write nothing
npx -y my-websearch@latest init --client cursor,code # target specific clients
```

Supported out of the box: **Claude Desktop**, **Cursor**, and **VS Code** (workspace `.vscode/mcp.json`). An existing entry is never overwritten unless you pass `--force`, corrupt config files are left untouched, and on Windows it writes `cmd /c npx` for you. Restart the client, then verify with `my-websearch doctor`.

#### 🔹 Manual configuration

**Claude Desktop / Cursor / Windsurf / Cline (STDIO Mode)**

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

*(For Windows: `init` handles this automatically. When configuring manually, if `npx` is not in the system path, set `command` to `cmd` and `args` to `["/c", "npx", "-y", "my-websearch@latest"]`)*

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

<a id="cli"></a>

## 💻 CLI & Local Daemon

`my-websearch` can be used directly from your terminal as a standalone CLI tool or persistent daemon. Use `--json` in automation and keep the daemon on `127.0.0.1` unless you explicitly need remote access:

```bash
# Global install
npm install -g my-websearch

# Detect installed MCP clients and write their config (--dry-run to preview)
my-websearch init

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

<a id="diagnostics"></a>

## 🩺 Diagnostics

Use the built-in doctor command before troubleshooting a proxy, browser, or engine:

```bash
# Local configuration and browser checks
my-websearch doctor

# Real proxy/engine probes (may contact upstream services)
my-websearch doctor --network

# Limit network probes to selected engines
my-websearch doctor --network --engine bing,duckduckgo --json

# Reset and clear cached engine circuit breaker / health state
my-websearch doctor --reset-health
```

The report separates configuration, proxy TCP reachability, HTTP reachability, application parsing, browser launch, and challenge verification status. Network mode performs real requests and should not be used as a high-frequency health check.

### 🌐 Proxy Troubleshooting & Upstream Rate Limiting

When configuring or diagnosing proxy connectivity, refer to these common edge cases:

1. **Startup log shows `🌐 Proxy: disabled` even though `proxy.url` is set?**
   - **Check `useProxy` flag**: In `~/.my-websearch/config.json`, setting `"useProxy": false` takes precedence and **explicitly overrides and disables `url`** (setting `PROXY_URL='false'`). Change `"useProxy": true` or simply omit the field (providing a valid `url` automatically enables the proxy).
   - **No system proxy active without `PROXY_URL`**: If no system proxy or local proxy client is running, overseas engines will be blocked by default. Explicitly declare `PROXY_URL` (e.g. `http://127.0.0.1:7897` or `7890`).

2. **Proxy is configured properly, but overseas engines fail or timeout? (Upstream IP Rate Limiting, NOT a Config Error)**
   - **DuckDuckGo returns HTTP 202 / challenge**: DDG rate-limits the egress IP. The first query may succeed and later ones return `anomalyDetectionBlock`; cookie warming cannot resolve this upstream rate limit. Change the egress IP or wait for cooldown.
   - **Bing returns HTTP 200 but 0 results**: the wreq impersonation path now falls back to the axios SERP path automatically when it parses an empty page. If both paths stay empty, the query/IP is likely rate-limited.
   - **Brave returns HTTP 429 Too Many Requests**: Brave Search rate-limits noisy datacenter IP ranges.
   - **Startpage times out or Anubis PoW difficulty spikes**: difficulty 6 is now solved inline by up to 4 worker threads (~3–12s); >6 is skipped. Pass-challenge socket errors / transient 5xx are retried automatically.
   - 💡 **Resolution**: These symptoms indicate that **the public egress IP has triggered upstream rate limiting**, not a bug in `my-websearch`. Switch to a different proxy server IP, fallback to domestic/direct engines, or supply an official API key such as `BRAVE_API_KEY` for guaranteed SLA.

<a id="configuration"></a>

## 🔐 Security Model (read before exposing the server)

The defaults are safe **as a package**, and every one of them matters:

| Default | What it protects |
|---|---|
| Bind to `127.0.0.1` | Nothing outside the machine can reach the port |
| No authentication | Acceptable *only* because of loopback binding |
| Host header validation | Blocks DNS-rebinding attacks from a browser on the same machine |
| CORS disabled | No cross-origin browser access |

**Relaxing one without the others silently removes the protection:**

- `HOST=0.0.0.0` (Docker) → the Host allowlist follows the bind address automatically; if you also use a public domain, add it via `OPEN_WEBSEARCH_ALLOWED_HOSTS` (comma-separated).
- Exposing to the public internet → put it behind a reverse proxy with authentication (or an SSH tunnel). The daemon prints a warning when bound to a non-loopback address.
- MCP session IDs are identifiers, **not credentials** — anyone who can reach the port can resume a session.
- `FETCH_WEB_INSECURE_TLS=true` disables certificate verification for *user-supplied URLs*; only enable it for a trusted network.
- The app copies API keys it finds in `~/.gemini/config/mcp_config.json` / `~/.workbuddy/mcp.json` into `~/.my-websearch/config.json` (mode `0600`) on first run. Run `my-websearch doctor` to see where each key came from; set `MYWEBSEARCH_NO_AUTO_BOOTSTRAP=1` to disable the copy.

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
    "useProxy": true,
    "engines": ["duckduckgo", "exa", "brave", "startpage"]
  }
}
```

> ⚠️ **Note on `useProxy`**: When `"url"` is configured, proxy is enabled automatically. Setting `"useProxy": false` will **explicitly override and disable `url`**. If you want proxy enabled, set `"useProxy": true` or omit the field entirely.

### 📋 Exhaustive Environment Variables Reference

Can be set via the global configuration file (`~/.my-websearch/config.json`), local `.env`, or system environment variables:

#### 1. 🔍 Search & Routing Orchestration

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `DEFAULT_SEARCH_ENGINE` | `auto` | Default engine: `auto` (smart query routing: Chinese `baidu,sogou`, English/foreign `bing,duckduckgo`). Supports all 14 engines: `auto`, `bing`, `baidu`, `sogou`, `duckduckgo`, `brave`, `csdn`, `juejin`, `startpage`, `exa`, `github`, `stackoverflow`, `hackernews`, `arxiv`, `code` (vertical developer engines can be configured as default, though `auto` or general web engines are recommended for global default) |
| `ALLOWED_SEARCH_ENGINES` | all | Comma-separated whitelist of allowed search engines (e.g. `bing,baidu,duckduckgo`) |
| `BING_BASE_URL` | `https://cn.bing.com/search` | Base URL for Bing queries. Overseas users or reverse proxy nodes can set to `https://www.bing.com/search` (legacy alias `OPEN_WEBSEARCH_BING_HOST` supported) |
| `DEFAULT_MIN_RESULTS` | `5` | Cascade threshold: triggers fallback engines when usable results are fewer than this value |
| `DEFAULT_SEARCH_LIMIT` | `10` | Default result limit when not explicitly specified in tool calls (max 50) |
| `SEARCH_DEADLINE_MS` | `30000` | Global hard deadline for multi-engine search execution (milliseconds) |
| `ENGINE_CIRCUIT_BASE_COOLDOWN_MS` | `30000` | First circuit-breaker cooldown for an engine (429 / 202 / bot_challenge). Repeated failures back off exponentially (30s → 60s → 120s…). |
| `ENGINE_CIRCUIT_MAX_COOLDOWN_MS` | `300000` | Upper bound for the exponential circuit-breaker backoff (default 5 minutes). |
| `SEARCH_AUTHORITY_DOMAINS` | empty | Additional authority domain whitelist for result re-ranking (comma-separated, appended to built-in list) |
| `SEARCH_MODE` | `auto` | Search mode and browser policy. Supports single mode, multi-engine per mode, and compound multi-mode combinations:<br/>• **Global mode**: `auto` (default fallback), `request`/`none` (pure HTTP), `playwright` (force browser)<br/>• **Single mode, multiple engines**: `playwright:bing,startpage`, `auto:bing,startpage`, `bing,startpage`<br/>• **Compound multiple modes**: `playwright:bing;auto:startpage` (bing forces browser, startpage uses auto fallback), `auto;request:startpage` (global auto but startpage uses pure HTTP) |
| `AUTO_ROUTE_EN_ENGINES` | `bing,duckduckgo` | Comma-separated engines for default English auto-routing |
| `AUTO_ROUTE_ZH_ENGINES` | `baidu,sogou` | Comma-separated engines for default Chinese auto-routing |

#### 2. 🌐 Proxy & Network Security

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `PROXY_URL` | empty (off) | Consolidated upstream proxy configuration (merges previous `USE_PROXY` and `PROXY_ENGINES`). Not needed in TUN mode.<br/>• **Default proxy**: passing empty `PROXY_URL=""` or `PROXY_URL=true` activates default `http://127.0.0.1:7897` (common local proxy ports include 7897, 7890, 10809; overseas engines use proxy, domestic engines stay direct)<br/>• **Custom address**: `PROXY_URL=http://127.0.0.1:10809`<br/>• **Custom engines**: `PROXY_URL="http://127.0.0.1:7897;duckduckgo,brave"` or all engines `PROXY_URL=";all"` |
| `FAKE_IP_CIDRS` | `198.18.0.0/15` | Whitelisted CIDRs for Fake-IP / TUN mode to avoid SSRF false-positive blocking |
| `IMPERSONATE_BROWSER` | `chrome_149` | `wreq-js` browser TLS/H2 fingerprint profile (e.g. `chrome_149`, `safari_18`) |
| `IMPERSONATE_OS` | `windows` | Operating system platform for fingerprint impersonation (`windows`, `macos`, `linux`) |
| `BING_IMPERSONATE` | `true` | Toggle Chrome TLS impersonation for Bing HTTP mode (auto-trips circuit breaker after consecutive empty results) |
| `ANUBIS_MAX_POW_DIFFICULTY` | `6` | Maximum difficulty threshold for Startpage Anubis PoW solver; skips/falls back when difficulty exceeds this |
| `DIRECT_FIRST_PROBE_TIMEOUT_MS` | `3500` | Timeout in ms for direct-first connection probes before proxy fallback |
| `FETCH_WEB_INSECURE_TLS`| `false` | Disable TLS certificate verification for `fetchWebContent` only (for broken legacy site certs) |
| `GITHUB_README_CDN_FIRST` | `false` | When `true`, forces skipping `raw.githubusercontent.com` direct probe and queries jsDelivr CDN first (domestic network acceleration) |

#### 3. 🔐 Credentials & API Keys

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `CONTEXT7_API_KEY` | empty | [Context7 API Key](https://context7.com/dashboard) (strongly recommended for proxy/TUN users to avoid shared IP quotas) |
| `EXA_API_KEY` | empty | [Exa Free API Key](https://dashboard.exa.ai/api-keys) (only required if using the `exa` semantic search engine) |
| `BRAVE_API_KEY` | empty | [Brave Search API Key](https://api.search.brave.com/app/keys) (optional; uses official high-reliability API when set) |
| `GITHUB_TOKEN` | empty | [GitHub Personal Access Token](https://github.com/settings/tokens) (optional; raises rate limit to 5,000 req/hr) |
| `GITEE_TOKEN` | empty | [Gitee Personal Access Token](https://gitee.com/profile/personal_access_tokens) (optional; raises Gitee API rate limits and enables private repos) |
| `STACKOVERFLOW_API_KEY` | empty | [Stack Apps Key](https://stackapps.com/apps/oauth/register) (optional; raises quota to 10,000 req/day) |

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
| `MCP_TOOL_FETCH_GITHUB_NAME` | `fetchGithubContent` | Custom registration name for the GitHub/Gitee content tool (set to `fetchGithubReadme` for backward compatibility) |

> 💡 **Zero-Config Upgrades (Redundant Variables Removed)**:
> - **CORS Switches** (`ENABLE_CORS`/`CORS_ORIGIN`): CORS is **disabled by default**; enable it explicitly and restrict origins when browser clients need cross-origin access.
> - **Playwright Package Selection** (`PLAYWRIGHT_PACKAGE`/`PLAYWRIGHT_MODULE_PATH`): Now **100% automated** via intelligent client and system binary discovery.
> - **Remote Browser Endpoint** (`PLAYWRIGHT_WS_ENDPOINT`): Unified into standard `PLAYWRIGHT_CDP_ENDPOINT`.
> - **Emoji Switch** (`OPEN_WEBSEARCH_NO_EMOJI`): Automatic console code page detection smoothly falls back to ASCII tags on legacy terminals.
> - **Fragmented Debug Flag** (`OPEN_WEBSEARCH_DEBUG`): Unified into standard `LOG_LEVEL=debug`.
> - **Cookie Persistence TTL** (`MYWEBSEARCH_COOKIE_TTL_DAYS`): Solidified to 30 days with automated sliding renewal.

---

<a id="development"></a>

## 🤝 Contributing & Tests

Pull requests and issues are welcome! To run the test suite locally:

```bash
npm install
npm run build
npm test              # Run the Vitest suite (55 files, 459 tests at the current baseline)
npm run test:live     # Run bounded-concurrency live integration tests
npm run eval:live     # Run 23-case live STDIO JSON-RPC evaluation suite
```

### Acknowledgements

**Author: wtznicy**

This project evolved from **Open-WebSearch** (originally created by Aas-ee) — special thanks to the original author. Thanks also to:
- **[wreq-js](https://www.npmjs.com/package/wreq-js)** for native Chrome TLS/HTTP2 fingerprint impersonation
- **[Context7](https://context7.com)** for powering official documentation retrieval
- **[Mozilla Readability](https://github.com/mozilla/readability) & [Turndown](https://github.com/mixmark-io/turndown)** for content extraction and GFM Markdown formatting
