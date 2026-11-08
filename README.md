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

- 🌐 **16-Engine Federated Search & Smart Routing**  
  Aggregates direct domestic engines (**Bing, Baidu, CSDN, Juejin, Sogou**), global engines (**DuckDuckGo, Brave, Startpage, Yahoo, Exa, Bing News**), and specialized developer platforms (**GitHub, StackOverflow, Hacker News, arXiv**). Features automatic language-aware routing (`auto`), parallel multi-query execution (`queries: string[]`), URL deduplication, and automatic `minResults` cascading fallback. When DuckDuckGo is unhealthy, **Yahoo automatically joins the English primary group** from the fallback pool.
- ⚡ **Native Web Protocol & Proof-of-Work Solvers (Browser-Free Fast Path, Browser Fallback Only When Needed)**  
  Built on `wreq-js` with native modern TLS/HTTP2 handshake emulation and persistent session cookies. Includes pure-JS/Rust solvers for **Startpage's Anubis SHA-256 PoW challenge** and **DuckDuckGo's `d.js` (`isJsaChallenge`) HTML5/arithmetic challenge**, so most challenges resolve without launching a browser. Request stacks are engine-specific: **DuckDuckGo requires the wreq Chrome profile via GET** (axios POST is challenged with HTTP 202), while **Brave defaults to curl HTTP/1.1** (Windows Schannel; tested curl 7/10 before rate limiting, axios 0/10, wreq HTTP/2 429). When a Brave 429 turns out to be an anti-bot challenge page, the engine retries once through a disguised headless CDP browser that clicks the Argon2 PoW button itself (~4–6s; measured 8/8 while plain HTTP stayed 429). Note: DuckDuckGo's page-level **HTTP 202 anomaly CAPTCHA** ("select all squares containing a duck") is human verification and is intentionally **not** bypassed — it is reported as `bot_challenge`; Brave's challenge is computational (Argon2 PoW) and is solved by the page's own JavaScript, not by us. Real URL resolution for Sogou redirect links, Baidu `Location`, and Bing Base64 links.
- 📄 **High-Purity Markdown Article Extraction & Dedicated Site Purifiers**  
  Combines Mozilla Readability with intelligent chrome noise stripping. Features dedicated purification rules for **WeChat Official Accounts** (`mp.weixin.qq.com`), **StackOverflow questions & accepted answers**, and transparent internal routing for **CSDN & Juejin**. Removes `<nav>`, `<aside>`, `<footer>`, and breadcrumbs while faithfully preserving article titles, code blocks, and GFM tables. Supports seamless pagination (`startIndex`), plus three token-saving modes: **BM25 relevance-ranked `focus`**, **CSS-selector `extract` to JSON with no LLM**, and **numbered `citations`**.
- 📚 **Unified Context7 Library Docs Lookup (`queryDocs`)**  
  Directly query official documentation with natural package names (e.g. `"next.js"`, `"vue"`) or Context7 IDs without needing a separate resolve step. Includes automatic candidate ranking, blind-guess 404 self-healing, and related alternatives discovery.
- 🐙 **Extended GitHub / Gitee Resource Fetcher**  
  `fetchGithubContent` (formerly `fetchGithubReadme`) supports both GitHub and Gitee: repository READMEs, any source file (`/blob/...`, with `lines`/`#L120-L180` slicing), directory trees (`/tree/...`), complete issue / PR discussions, commits (`/commit/<sha>`), compare views (`/compare/a...b`), and releases (`/releases`, `/releases/tag/<tag>`).
- 🌏 **Zero-Config Network Detection & Fake-IP Ready**  
  Auto-detects OS system proxies (Windows Registry / macOS scutil / Linux env). Automatically routes overseas engines through proxy while keeping domestic engines on fast direct lines. Pre-whitelists `198.18.0.0/15` for TUN / Fake-IP compatibility while enforcing strict SSRF security bounds.
  **No proxy is the supported default**: outside mainland China, leave `PROXY_URL` unset and every engine is queried directly — you don't need Clash/v2ray to use this server.
- 🔌 **Versatile Deployment Modes**  
  Works seamlessly across **MCP STDIO** (Claude Desktop/Cursor), **Streamable HTTP / SSE** (Cherry Studio/remote clients), **CLI one-shot commands**, and a **Local HTTP Daemon** with connection pool reuse and Prometheus `/metrics` monitoring.

---

## 🌍 16 Search Engines

| Engine | Mainland China Connectivity | API Key | Core Technology | Best For |
| :--- | :---: | :---: | :--- | :--- |
| **`bing`** | 🇨🇳 Direct | None | Chrome TLS impersonation + Base64 real URL resolution + stealth fallback | General technical search, mixed EN/ZH queries |
| **`bing-news`** | 🌐 Proxy in CN | None | **Bing News RSS** + `pubDate` 24h filter + `apiclick.aspx?url=` decoding; direct can 302 to an HTML page, so it is proxy-eligible by default; opt-in vertical engine | Breaking news, last-24h updates |
| **`baidu`** | 🇨🇳 Direct | None | Concurrent `Location` redirect resolution + challenge detection | Chinese news, documentation, domestic forums |
| **`csdn`** | 🇨🇳 Direct | None | WAF cookie jar persistence + empty response auto-retry | Chinese error logs, debugging tutorials |
| **`juejin`** | 🇨🇳 Direct | None | Direct official API querying for clean long-form articles | Modern frontend/backend technical blogs |
| **`sogou`** | 🇨🇳 Direct | None | Desktop & mobile dual parsing + redirect link decoding + ad removal | WeChat ecosystem links & long-tail queries |
| **`duckduckgo`** | 🌐 Proxy in CN | None | **wreq Chrome-profile GET of the HTML endpoint** (202 anomaly CAPTCHA only on the axios fallback); `d.js` solver retained for the preload fallback | English technical search & open-source discussions |
| **`startpage`** | 🌐 Proxy in CN | None | **Multi-worker Anubis SHA-256 PoW solver** (difficulty ≤ 6) + cookie session (no browser needed) | Google-backed high-privacy results |
| **`yahoo`** | 🌐 Proxy in CN | None | SSR HTML + homepage cookie warm-up + `RU=` redirect decoding; **English fallback pool** (auto-substitutes when DuckDuckGo is unhealthy) | Stable Bing-index English fallback |
| **`brave`** | 🌐 Proxy in CN | None | **curl HTTP/1.1** (Windows Schannel; tested 7/10 before 429; axios 0/10; wreq HTTP/2 429) + strict sponsored ad stripping; compatible with Windows' older curl builds (no `--compressed` requirement); on 429 it auto-triggers the PoW challenge through a disguised desktop headless CDP browser (~4–6s, measured 8/8 while HTTP stayed 429); if that still fails: wait / rotate IP / use `BRAVE_API_KEY` | Independent English index & technical blogs |
| **`exa`** | 🌐 Proxy preferred | Optional Free Key | Official semantic search API (skipped if key is unset); direct works too, but proxy measured ~0.77s vs ~1.17s direct | Semantic similarity, AI research & papers |
| **`github`** | 🌐 Direct API | None | Official GitHub Search REST API + **exact owner/repo fast path** (issues & repositories) | GitHub issues, bug reports, repositories, and exact repo lookup |
| **`stackoverflow`**| 🌐 Direct API | None | Official StackExchange 2.3 API with HTML entity decoding | Developer troubleshooting, stack traces & answers |
| **`hackernews`** | 🌐 Direct API | None | Algolia HN Search API with points, comments & author metadata | Tech discussions, startup launches & engineering news |
| **`arxiv`** | 🌐 Direct API | None | Official arXiv Atom XML API parsing titles, authors & abstracts | Scientific papers, machine learning & AI research |
| **`code`** | 🌐 Proxy in CN | None | grep.app API search across global GitHub code with repo, path & exact line numbers | Source code implementations, API usage patterns |

> **Version note**: this README tracks the current source tree (**1.5.1**). **1.5.1** is a search-quality release: diversity-aware early return (usable results + ≥2 engines or ≥3 domains), host cap (≤2 per domain, ≤3 for official docs), Chinese-tech routing to Bing/Baidu/Sogou, entity/title relevance guards, official-intent anchor injection (MCP/Vitest/Node.js/Next.js/React/Vue/TypeScript/Docker/PostgreSQL/Zustand) plus an official LTS page for Node.js version queries, Baidu real-URL extraction, version-aware ranking for date-based specs, a 3.5 s cascade cap / 3.5 s CSDN timeout, `apiKeys.gitee` support, fast-fail `codeSymbol` without `GITHUB_TOKEN`, and an `npm run eval:quality` 10-scenario benchmark. **1.5.0** unified the test suite (all legacy scripts migrated to Vitest, single runner in CI), centralized every `process.env` read behind `src/config/env.ts` (enforced by ESLint), splits the four largest modules, adds a **180 s browser-only window** after a Brave 429, lazy-loads the server stack for a ~0.32 s CLI cold start, adds `doctor --network` cache-hit-rate / circuit-remaining / P50-P95 metrics, upgrades core dependencies (MCP SDK 1.32, axios 1.21, cheerio 1.2, express 5.3, zod 4), and requires **Node.js ≥22** (Vitest 5 and the optional `unpdf` PDF parser both require it; `node:sqlite` is used when available, with a sharded-JSON fallback) plus a Windows CI job on Node 22. Earlier: **1.4.2** added Brave 429 challenge detection (`captcha` vs `quota`) and the disguised CDP browser fallback; **1.4.1** fixed Windows curl 8.4 compatibility; **1.4.0** added `codeSymbol`, CDP device profiles and DDG 202 fallback. npm latest may lag until the package is published.

---

<a id="mcp-tools"></a>

## 🛠️ 5 Core MCP Tools (Minimal & Token-Efficient)

> 💡 **Token Budget & Slimming**: All tool descriptions are strictly kept within 250 characters (total description characters ≤ 1200), while detailed routing guidance is delegated to `McpServer({ instructions })`, significantly reducing LLM context consumption.

| Tool Name | Purpose | Key Highlights |
| :--- | :--- | :--- |
| **`search`** | Federated web & code search (16 engines) | Supports parallel queries, `timeRange: day\|week\|month\|year` date filter, `site: string[]` filter, and query operators (`site:`, `filetype:`, `after:`, `before:`, `-exclude`) translated per engine with local post-filtering; `fetchTop` preview injection, `code` engine (grep.app); explicit `engines` defaults to `minResults=0` (no unconstrained cascade); returns inline `diagnostics` on failure |
| **`fetchWebContent`** | Web page extraction, Markdown & transparent PDF parsing | **All-in-one content extractor**: Built-in disk-level Markdown cache (Node 22 `node:sqlite` / partitioned JSON fallback, 200MB LRU, `cache: default\|reload`); transparent PDF parsing (up to 20MB / 50 pages, `[page N]` tags, scanned doc detection); pagination & `focus` keyword targeting (**`bm25`** relevance-ranked blocks by default, `window` for the legacy fixed window); **`selector`** to scope extraction to a CSS subtree (errors instead of silently returning the whole page); **`extract`** for CSS-selector JSON with no LLM; **`citations`** for numbered references; **`retainLinks`** to strip URLs (-50% on index pages) |
| **`fetchGithubContent`** | Comprehensive GitHub / Gitee content reader | Fetches README, **one source file** (`/blob/<ref>/<path>`, optional `lines`/`#L120-L180` slicing with a 400-line cap), directory trees (`/tree/`, lock/build artifacts filtered), Issue / PR discussions, commits (`/commit/<sha>`), compare (`/compare/a...b`, capped patch + lockfile filtering), and releases (`/releases[/tag/<tag>]`, `releaseLimit` 1-30); `ref` may be a branch, tag, or commit; Gitee parity via API (optional `GITEE_TOKEN`); returns `warnings` |
| **`queryDocs`** | All-in-one official docs, middleware & Web standards API | **Multi-Source Authority**: Resolves package names, middleware, or Context7 IDs; optional **`source`** selection (`auto` smart cascade, `official` standalone sites, `docs.rs` Rust, `pkg.go.dev` Go, `devdocs` 800+ tools/langs, `mdn` Web standards, `javadoc` Maven packages, `context7`, `npm`, `pypi`, `github`); optional **`version`** multi-source pinning; **Syntax-Level Markdown Section Extraction** (for docs >8000 chars with `query`, keeps preamble `import` & bootstrap code 100% intact, extracts full matching sections with TOC; zero truncation for short docs); **24h local cache** (`cache: reload` bypasses); precise failover notices (402 Quota vs outages vs low-confidence); returns `source`, `confidence`, `documentationUrl` & `warnings` |
| **`codeSymbol`** | Remote GitHub symbol lookup | GitHub code search + raw/CDN files; optional Tree-sitter AST (grammar downloaded/cached in background, scanner fallback, one parse for definitions + call sites); multi-line signatures, Python decorators, lexical brace matching, filtered call sites, re-export + monorepo tsconfig `extends`/paths; TypeScript/JavaScript checker types plus Python/Go/Rust annotation-level types; symbol/content/analysis TTL caches and a soft time budget with partial results; private repos via Contents API; requires `GITHUB_TOKEN`; unresolved imports become `any` |

> 💡 **Backward Compatibility**: Legacy `fetchCsdnArticle` and `fetchJuejinArticle` are automatically routed under `fetchWebContent`; legacy `resolveLibraryId` is merged into `queryDocs` (which accepts a `library` name or the legacy `libraryId` alias). The separate legacy tools were removed — the `REGISTER_LEGACY_ARTICLE_TOOLS` switch is gone, because keeping three unregistered handlers around still cost tool-description budget for nothing.

> 🧩 **MCP Prompts**: `deep-research` (multi-source research with citations) and `code-lookup` (official docs + source + release notes) are registered as server-side prompt templates; clients that support MCP Prompts can invoke them directly.

> 🗂️ **MCP Resources**: read-only `websearch://cache/pages` / `websearch://cache/docs` indexes plus per-entry Markdown resources expose already-cached content without another tool call. Resources never trigger network fetches.

### 📚 queryDocs Multi-Source Documentation & Syntax Section Extraction

`queryDocs` is purpose-built for AI Agents, connecting directly to authoritative primary documentation for open-source libraries, infrastructure middleware, and Web standards:

1. **Multi-Source Architecture (`source` parameter)**:
   - `auto` (Default smart routing & cascade): Tries Context7 first; on quota exhaustion or missing index, automatically cascades to **Standalone Official Doc Sites** $\to$ **DevDocs** $\to$ **Registry Readmes (npm / PyPI / crates.io / Go Proxy / Maven) & GitHub**. Supports prefix shortcuts like `crates:`, `go:`, `mdn:`, `devdocs:`, and `javadoc:`.
   - `official`: Connects directly to dedicated official documentation sites (e.g. FastAPI, Vue, Vite, Next.js).
   - `devdocs`: Covers 800+ offline/standard API documentation sets (e.g. Redis, Docker, Nginx, PostgreSQL, Python, C++, Bash), with native versioned slugs (e.g. `python~3.12`, `angular~21`).
   - `mdn`: Connects to official MDN Web Docs APIs (JavaScript standards, Web APIs, CSS, HTML), with automatic English/Chinese detection and localized `locale=zh-CN` extraction.
   - `docs.rs`: Connects directly to the official Rust crates documentation ecosystem with precise version pinning.
   - `pkg.go.dev`: Connects directly to official Go modules and standard library documentation.
   - `javadoc`: Resolves Maven coordinates (`groupId:artifactId`) directly on Javadoc.io.
   - `context7`: Context7 structured LLM codebase documentation index.
   - `npm` / `pypi` / `github`: Ecosystem registry metadata sniffing and README fallbacks.

2. **Syntax-Level Markdown Section Extraction (Preamble & Imports Protection)**:
   - **Problem Solved**: Naive token chunking frequently strips out top-of-file dependencies (`import` / `require`) and initialization setup, causing LLMs to generate hallucinated or broken code.
   - **Guaranteed Preamble Preservation**: When a document is large (>8000 characters) and a `query` is provided, the extractor **100% guarantees** complete preservation of the preamble: package declarations, installation instructions, every `import` statement, and bootstrap setup.
   - **Closed Sections & Global TOC**: Matching sections are extracted completely in full context without mid-sentence truncations; untargeted sections are synthesized into a compact Table of Contents at the end. Short documents ($\le$ 8000 characters) are delivered in full without slicing.

3. **Multi-Source Version Pinning & Transparent Failover**:
   - Consistent `version` parameter across sources (e.g. `18.2.0`, `3.11`, `1.38.0`, `v1.9.1`).
   - Clear distinction between Context7 **HTTP 402 (Monthly Quota Exhausted)**, transient service outages, and low-confidence unindexed targets. Failovers supply actionable hints in `warnings` for configuring `CONTEXT7_API_KEY` or switching sources.

```json
// Example 1: Query Redis commands via DevDocs
{ "library": "redis", "query": "hset", "source": "devdocs" }

// Example 2: Query Web standard APIs via MDN (localized extraction)
{ "library": "fetch", "source": "mdn" }

// Example 3: Query a specific Rust crate version via docs.rs
{ "library": "tokio", "version": "1.38.0", "source": "docs.rs" }

// Example 4: Long document with section extraction preserving imports
{ "library": "fastapi", "query": "middleware" }
```

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

# Only results published within the last week (day|week|month|year)
my-websearch search "typescript 5.9 release" --time-range week --json

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
# Local configuration and browser checks (path only; use --browser to verify launch)
my-websearch doctor

# Verify the Chromium-based browser can actually launch (auto-detected, CHROME_PATH, or PLAYWRIGHT_CDP_ENDPOINT)
my-websearch doctor --browser

# Real proxy/engine probes (may contact upstream services)
my-websearch doctor --network

# Limit network probes to selected engines
my-websearch doctor --network --engine bing,duckduckgo --json

# Reset and clear cached engine circuit breaker / health state
my-websearch doctor --reset-health
```

The report separates configuration, proxy TCP reachability, HTTP reachability, application parsing, browser launch, and challenge verification status. For Brave, a 429 is additionally classified as `captcha` (human verification — retrying usually stays challenged) or `quota` (rate-limit window) in both the text report (`challenge=...`) and `--json` (`challengeKind`). Network mode also summarizes cache hit rates (search cache and fetch page cache), remaining circuit cooldowns per engine, and P50/P95 engine latency when persisted samples exist. Network mode performs real requests and should not be used as a high-frequency health check.

### 🌐 Proxy Troubleshooting & Upstream Rate Limiting

When configuring or diagnosing proxy connectivity, refer to these common edge cases:

1. **Startup log shows `🌐 Proxy: disabled` even though `proxy.url` is set?**
   - **Check `useProxy` flag**: In `~/.my-websearch/config.json`, setting `"useProxy": false` takes precedence and **explicitly overrides and disables `url`** (setting `PROXY_URL='false'`). Change `"useProxy": true` or simply omit the field (providing a valid `url` automatically enables the proxy).
   - **System proxy is auto-detected**: when no explicit proxy is configured, the OS system proxy (Windows registry / macOS `scutil` / `HTTPS_PROXY`) is used for overseas engines and generic fetches — you do **not** need `PROXY_URL` just because a proxy client is running. If detection fails or you want to pin a specific proxy, set `PROXY_URL` (e.g. `http://127.0.0.1:7897`).
   - **Prefer `~/.my-websearch/config.json` over client `env`**: put `proxy.url` and API keys in the config file. Some MCP clients (e.g. WorkBuddy) fingerprint the server by `command + args + env key names + cwd`, so adding a `PROXY_URL` env entry changes the trust fingerprint and the server may silently drop out of the session. Config-file settings are read at startup and avoid that.
   - **Where to put the proxy** (the error message used to say only "MCP client config", which was ambiguous):
     | Location | Use it when |
     | :--- | :--- |
     | `~/.my-websearch/config.json` → `"proxy": { "url": "http://127.0.0.1:7897" }` | **Recommended.** Applies to every client (CLI, daemon, MCP) and does not change client trust fingerprints. |
     | MCP client `env` → `PROXY_URL` | Per-client override. Restart the client; some clients include env keys in their trust fingerprint. |
     | Proxy client's "system proxy" switch | No config at all. Since **1.3.8** it is auto-detected for overseas engines and generic fetches. |

2. **Proxy works, but an overseas engine still fails or times out? (Per-engine diagnosis, not a config error)**
   - **DuckDuckGo returns HTTP 202 / challenge**: the 202 body is DDG's **anomaly CAPTCHA** (human verification), not a plain per-IP rate limit; the `d.js` arithmetic solver does not bypass it. The engine first requests the HTML endpoint with a **wreq Chrome-profile GET**, which normally returns 200 even when the axios POST path is challenged with 202 — so a 202 now only appears if that path fails and the axios fallback is used. If you still see 202, confirm your build includes the wreq GET path (**1.3.8 and earlier do not**), then retry or check that the proxy is attached. **DDG remains best-effort**: the same exit can still be challenged intermittently, so do not treat it as an SLA; for stability use Bing/Startpage or configure `BRAVE_API_KEY`/`EXA_API_KEY`. Note: `SEARCH_MODE=playwright:duckduckgo` is not supported (DDG has no browser-rendering path), so it falls back to HTTP.
   - **Bing returns HTTP 200 but 0 results**: the wreq impersonation path now falls back to the axios SERP path automatically when it parses an empty page. If both paths stay empty, the query/IP is likely rate-limited.
   - **Brave returns HTTP 429 Too Many Requests**: after a limited number of requests the CloudFront edge starts serving an anti-bot challenge page (HTTP 429) to the exit IP, while the first requests often still depend on the client TLS/HTTP stack. Fresh-node measurements: **axios (Node OpenSSL, HTTP/1.1) → 0/10, all 429**; **curl (Schannel, HTTP/1.1) → 7/10 then 3/3 429**; **wreq (HTTP/2 Chrome) → 429**; **.NET Schannel HTTP/2 → 200/429 mixed**. After curl hit 429, retrying **.NET Schannel HTTP/2 on the same URL was 0/3, and on fresh URLs 0/3** — once the IP quota is exhausted, changing the client stack does not help. The Brave web path always uses curl (Windows Schannel; no axios fallback) and trips a **rolling 60-second window of 6 requests** — the 7th request is challenged (measured on a clean exit at 1 request / 10 s: 6 × 200, then 429). The 429 body is not a plain quota page: it is Brave's SPA challenge (captcha + Argon2 `challengeSet`), so it is reported as `bot_challenge` rather than `rate_limited`. Recovery follows the window, not a fixed timer: requests pass again once the oldest request of the burst ages out of 60 s (measured 62.9 s after a 6-request burst; ~15 s when the same 6 requests were spread over 52 s). **Retrying inside the window adds requests and extends it** — probing every 15 s / 30 s kept the IP blocked for 255 s / 6.5 min respectively. The engine therefore trips the Brave circuit for **60 s** (then 120 → 240 → 300 s) and retries once through a disguised desktop headless CDP browser that clicks the PoW `验证` button automatically (8/8 success, ~4–6 s per query on a hard-blocked IP). That fallback only serves that search and does **not** clear the HTTP window: after a successful browser pass, the next HTTP attempt succeeded once and then hit 429 again. Client-stack swaps do not help either (axios 0/10; wreq HTTP/2 429; curl Schannel HTTP/1.1 7/10 before the window trips). The official API (`BRAVE_API_KEY`) remains the stable path. `BRAVE_BROWSER_FALLBACK=0` disables both the retry and the window. After a 429 the engine enters a **180 s browser-only window** (long-running MCP/daemon processes only; one-shot CLI invocations start fresh): HTTP is skipped entirely and every Brave call goes straight to the disguised browser (no wasted curl request that would only extend the server-side window); browser-only engines stay eligible but are ranked last by auto routing and cascade, so they do not slow down normal searches; if the browser fails too, the circuit opens (60 → 120 → 240 → 300 s) and routing/cascade substitute other engines.
   - **Startpage times out or Anubis PoW difficulty spikes**: difficulty 6 is now solved inline by up to 4 worker threads (~3–12s); >6 is skipped. Pass-challenge socket errors / transient 5xx are retried automatically.
   - 💡 **Resolution**: these are upstream anti-bot/rate-limit behaviours, not a broken MCP configuration. Handle them per engine: DDG 202 → upgrade/retry (the wreq GET path; in `auto` mode Yahoo also replaces an unhealthy DDG from the fallback pool); Brave 429 → the disguised-browser fallback usually rescues it (see above); otherwise wait out the window, rotate the exit IP, or set `BRAVE_API_KEY`; Bing 0 results → retry or adjust the query; Startpage PoW → retry. Switch exit IP only after the engine-specific step fails. As a last resort use `engines: ["bing", "baidu"]`, or configure an official key (`BRAVE_API_KEY` / `EXA_API_KEY`) for an SLA path.

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

> ⚠️ **Note on `useProxy`**: When `"url"` is configured, proxy is enabled automatically. Setting `"useProxy": false` will **explicitly override and disable `url`**. If you want proxy enabled, set `"useProxy": true` or omit the field entirely.
> **Keys & restart**: entries under `apiKeys` are mapped to env vars at startup (`github` → `GITHUB_TOKEN`, `gitee` → `GITEE_TOKEN`, `context7` → `CONTEXT7_API_KEY`, …) and only fill variables that are **not already set** in the client env. Restart the MCP server after editing the file; `my-websearch doctor` shows which keys are currently visible.

### 📋 Exhaustive Environment Variables Reference

Can be set via the global configuration file (`~/.my-websearch/config.json`), local `.env`, or system environment variables:

**Precedence** (highest first): process environment → project `.env` → project `.my-websearch.json` → `~/.my-websearch/config.json` → built-in defaults.

#### 0. 🖥️ Server & Runtime

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `MODE` | `both` | `both` / `http` / `stdio`. `http` enables Streamable HTTP + SSE. |
| `HOST` | `127.0.0.1` | MCP HTTP bind address. Binding to a non-loopback address also registers that host in the Host allowlist and prints a no-auth warning. |
| `PORT` | `3211` | MCP HTTP port |
| `OPEN_WEBSEARCH_ALLOWED_HOSTS` | empty | Extra Host-header allowlist entries (comma-separated), needed when serving through a public domain/reverse proxy |
| `OPEN_WEBSEARCH_DAEMON_HOST` / `OPEN_WEBSEARCH_DAEMON_PORT` | `127.0.0.1` / `3210` | Local REST daemon bind address (no auth: keep it on loopback) |
| `METRICS_ENABLED` | `false` | Enables in-process counters and the daemon `/metrics` endpoint |
| `FETCH_WEB_DEADLINE_MS` | `45000` | Hard deadline for one `fetchWebContent` call (cookie + browser + retries combined) |
| `GITHUB_CONTENT_CDN_FIRST` | `false` | Prefer jsDelivr over `raw.githubusercontent.com` for **README and source files** (public repos only). |
| `GITHUB_CONTENT_BUDGET_MS` | `12000` (`6000` in CDN-first) | Total time budget for one `fetchGithubContent` call; per-attempt timeout is capped at 4.5s. |
| `BING_BROWSER_BUDGET_MS` / `BING_PLAYWRIGHT_BUDGET_MS` | `6000` | Budget for the Bing browser fallback (now backed by raw CDP) before HTTP results are kept; legacy name `BING_PLAYWRIGHT_BUDGET_MS` supported |
| `MYWEBSEARCH_NO_AUTO_BOOTSTRAP` | unset | Set to `1` to stop copying API keys out of other apps' MCP configs on first run |

#### 1. 🔍 Search & Routing Orchestration

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `DEFAULT_SEARCH_ENGINE` | `auto` | Default engine: `auto` (smart query routing: Chinese `baidu,sogou`, English/foreign `bing,duckduckgo`). Supports all 16 engines: `auto`, `bing`, `bing-news`, `baidu`, `sogou`, `duckduckgo`, `brave`, `csdn`, `juejin`, `startpage`, `yahoo`, `exa`, `github`, `stackoverflow`, `hackernews`, `arxiv`, `code` (vertical developer engines can be configured as default, though `auto` or general web engines are recommended for global default) |
| `ALLOWED_SEARCH_ENGINES` | all | Comma-separated whitelist of allowed search engines (e.g. `bing,baidu,duckduckgo`) |
| `BING_BASE_URL` | `https://cn.bing.com/search` | Base URL for Bing queries. Overseas users or reverse proxy nodes can set to `https://www.bing.com/search` |
| `DEFAULT_MIN_RESULTS` | `5` | Cascade threshold: triggers fallback engines when usable results are fewer than this value |
| `DEFAULT_SEARCH_LIMIT` | `10` | Default result limit when not explicitly specified in tool calls (max 50) |
| `SEARCH_DEADLINE_MS` | `30000` | Global hard deadline for multi-engine search execution (milliseconds) |
| `SEARCH_FUSION` | `legacy` | Result fusion mode: `legacy` (engine-hit count + arrival order) or `rrf` (Reciprocal Rank Fusion over per-engine ranks, which also replaces the position/consensus terms in re-ranking). RRF stays opt-in until a larger evaluation exists. |
| `SEARCH_FUSION_RRF_K` | `20` | RRF constant k; lower values amplify rank differences. Only used when `SEARCH_FUSION=rrf`. |
| `ENGINE_CIRCUIT_BASE_COOLDOWN_MS` | `30000` | First circuit-breaker cooldown for an engine (429 / 202 / bot_challenge). Repeated failures back off exponentially (30s → 60s → 120s…). Brave overrides the first step to **60s** because its 429 is a rolling 60-second window of 6 requests (the 7th is challenged) and recovery only starts once the oldest request ages out; setting this variable explicitly disables the per-engine override. |
| `SEARCH_AUTHORITY_DOMAINS` | empty | Additional authority domain whitelist for result re-ranking (comma-separated, appended to built-in list) |
| `SEARCH_MODE` | `auto` | Search mode and browser policy. Supports single mode, multi-engine per mode, and compound multi-mode combinations:<br/>• **Global mode**: `auto` (default fallback), `request`/`none` (pure HTTP), `browser`/`playwright` (force CDP browser)<br/>• **Single mode, multiple engines**: `browser:bing,startpage`, `auto:bing,startpage`, `bing,startpage`<br/>• **Compound multiple modes**: `browser:bing;auto:startpage` (bing forces browser, startpage uses auto fallback), `auto;request:startpage` (global auto but startpage uses pure HTTP) |
| `BRAVE_BROWSER_FALLBACK` | `1` | When the keyless Brave web path returns HTTP 429 / an anti-bot challenge, retry once through a disguised desktop headless CDP browser that auto-triggers the Argon2 PoW `验证` button (`1` enabled, `0` disables and fails fast). A 429 then opens a **180 s browser-only window**: HTTP is skipped and every Brave call in the window goes straight to the browser; if that also fails the engine trips its circuit (60 → 120 → 240 → 300 s) and routing/cascade substitute other engines. Measured 8/8 success at ~4–6s per query while plain HTTP stayed 429. Still best-effort: it cannot pass the interactive slider CAPTCHA |
| `AUTO_ROUTE_EN_ENGINES` | `bing,duckduckgo` | Comma-separated engines for default English auto-routing |
| `AUTO_ROUTE_ZH_ENGINES` | `baidu,sogou` | Comma-separated engines for default Chinese auto-routing |

#### 2. 🌐 Proxy & Network Security

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `PROXY_URL` | empty (off) | Consolidated upstream proxy configuration (merges previous `USE_PROXY` and `PROXY_ENGINES`). Not needed in TUN mode.<br/>• **Default proxy**: passing empty `PROXY_URL=""` or `PROXY_URL=true` activates default `http://127.0.0.1:7897` (common local proxy ports include 7897, 7890, 10809; overseas engines use proxy, domestic engines stay direct)<br/>• **Custom address**: `PROXY_URL=http://127.0.0.1:10809`<br/>• **Custom engines**: `PROXY_URL="http://127.0.0.1:7897;duckduckgo,brave"` or all engines `PROXY_URL=";all"` |
| `FAKE_IP_CIDRS` | `198.18.0.0/15` | Whitelisted CIDRs for Fake-IP / TUN mode to avoid SSRF false-positive blocking |
| `CUSTOM_DNS_SERVERS` | `223.5.5.5,119.29.29.29,1.1.1.1,8.8.8.8` | Comma-separated DNS servers used by the internal c-ares resolver (helps when the system DNS is polluted). Overrides the built-in list entirely |
| `IMPERSONATE_BROWSER` | `chrome_149` | `wreq-js` browser TLS/H2 fingerprint profile (e.g. `chrome_149`, `safari_18`) |
| `IMPERSONATE_OS` | `windows` | Operating system platform for fingerprint impersonation (`windows`, `macos`, `linux`) |
| `BING_IMPERSONATE` | `true` | Toggle Chrome TLS impersonation for Bing HTTP mode (auto-trips circuit breaker after consecutive empty results) |
| `FETCH_WEB_INSECURE_TLS` | `false` | Disable TLS certificate verification for `fetchWebContent` only (for broken legacy site certs) |

> **Custom proxy engine lists**: if you set `proxy.engines` in `~/.my-websearch/config.json` or use the `;engine1,engine2` suffix of `PROXY_URL`, **`yahoo` and `bing-news` are added automatically** because they cannot be reached directly from CN (Yahoo times out in 15–20s; Bing News returns a 302/HTML page). Removing the list entirely is still recommended: defaults include them and keep the direct API engines (GitHub / Stack Overflow / Hacker News / arXiv) off the proxy.

#### 3. 🔐 Credentials & API Keys

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `CONTEXT7_API_KEY` | empty | [Context7 API Key](https://context7.com/dashboard) (strongly recommended for proxy/TUN users to avoid shared IP quotas) |
| `EXA_API_KEY` | empty | [Exa Free API Key](https://dashboard.exa.ai/api-keys) (only required if using the `exa` semantic search engine) |
| `BRAVE_API_KEY` | empty | [Brave Search API Key](https://api.search.brave.com/app/keys) (optional; uses official high-reliability API when set) |
| `GITHUB_TOKEN` | empty | [GitHub Personal Access Token](https://github.com/settings/tokens) (optional; raises rate limit to 5,000 req/hr) |
| `GITEE_TOKEN` | empty | [Gitee Personal Access Token](https://gitee.com/profile/personal_access_tokens) (optional; raises Gitee API rate limits and enables private repos). Also configurable as piKeys.gitee in ~/.my-websearch/config.json. |
| `STACKOVERFLOW_API_KEY` | empty | [Stack Apps Key](https://stackapps.com/apps/oauth/register) (optional; raises quota to 10,000 req/day) |

#### 4. 🖥️ Server Modes, Concurrency & Session Reaper

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `MODE` | `both` | MCP transport mode: `stdio` (stdin/stdout only), `http` (HTTP/SSE only), `both` (concurrent) |
| `PORT` | `3211` | MCP HTTP/SSE listen port (local persistent daemon uses `3210` by default) |
| `MAX_CONCURRENT_SEARCHES` | `20` | Max concurrent searches in daemon mode (`0` for unlimited) |
| `MCP_MAX_SESSIONS` | `100` | Max retained MCP HTTP sessions before returning HTTP 429 Too Many Requests |
| `MCP_SESSION_TTL_MS` | `1800000` | Idle session expiration duration before reaping (default 30 min) |
| `LOG_LEVEL` | `info` | Log level: `quiet` (completely silent), `debug`, `info`, `warn`, `error` |
| `SECURITY_AUDIT` | `false` | Enable SSRF blocking and host header security audit logging |
| `OPEN_WEBSEARCH_ALLOWED_HOSTS` | loopback | Host header whitelist for HTTP server (DNS Rebinding protection, comma-separated) |

#### 5. 🧭 CDP Browser & Stealth Controls (legacy Playwright env names kept)

> [!NOTE]
> The browser fallback uses **raw Chrome DevTools Protocol** via `chrome-remote-interface`, so it requires a **Chromium-based** browser: Chrome, Edge, Chromium, Brave, Vivaldi or Opera (Firefox/WebKit are **not** supported). Standard install paths for all of these are auto-detected; override with `CHROME_PATH` / `BROWSER_PATH` / `PLAYWRIGHT_EXECUTABLE_PATH`, or connect a remote browser via `PLAYWRIGHT_CDP_ENDPOINT` (no local install needed). `my-websearch doctor --browser` reports which browser was found and how to fix a missing one. The `PLAYWRIGHT_*` env names and `SEARCH_MODE=playwright` value are kept for backward compatibility only. Browser fallback behavior is governed by `SEARCH_MODE`.

Two independent knobs — don't mix them up:

- **`BROWSER_DRIVER`** picks the *driver library*: `cdp` (default, built in via `chrome-remote-interface`) or `playwright` (legacy escape hatch that requires you to install `playwright-core`).
- **`PLAYWRIGHT_CDP_ENDPOINT` / `CHROME_PATH` / `BROWSER_PATH` / `PLAYWRIGHT_EXECUTABLE_PATH`** decide *where the browser comes from*: an already-running local/remote CDP endpoint, an explicit executable, or auto-detection.

Every browser path — Bing fallback, Startpage, DuckDuckGo, Brave, `fetchWebContent`, CSDN article fetch, and `doctor --browser` — goes through the same entry point, so these settings apply to all of them.

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `BROWSER_DRIVER` | `cdp` | Browser backend. `cdp` (default, raw CDP). `playwright` is a legacy escape hatch and requires you to install `playwright-core` manually; it is no longer bundled. |
| `BROWSER_PROFILE` | `off` | CDP device profile: `off`, `windows-chrome-8`, `windows-chrome-16`, `macos-chrome-8`, or `random`. Applies UA, screen/DPR, timezone and locale to browser sessions. It does not affect HTTP-only engines such as DuckDuckGo/Brave. |
| `DDG_BROWSER_FALLBACK` | `1` | When DuckDuckGo's HTTP paths return 202/CAPTCHA, retry the HTML endpoint through the CDP browser. Uses `BROWSER_PROFILE` when set, otherwise the coherent `windows-chrome-8` default; set `0` to disable. |
| `BROWSER_CDP_ENDPOINT` / `PLAYWRIGHT_CDP_ENDPOINT` | empty | Remote Chrome/Edge CDP endpoint URL (e.g. `http://127.0.0.1:9222` or `ws://...`); legacy name, used by the CDP driver |
| `BROWSER_PATH` / `PLAYWRIGHT_EXECUTABLE_PATH` | auto | Absolute path to a **Chromium-based** browser executable. Auto-detection covers Chrome / Edge / Chromium / Brave / Vivaldi / Opera in standard locations; `CHROME_PATH` and `BROWSER_PATH` are checked first and work as equivalents; legacy name |
| `BROWSER_HEADLESS` / `PLAYWRIGHT_HEADLESS` | `true` | Run headless (on Windows, an isolated hidden desktop window is used); legacy name |
| `BROWSER_TIMEOUT_MS` / `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | `20000` | Hard page navigation timeout (milliseconds); legacy name, applied to CDP navigation |

#### 6. 🛠️ Application Directory & Tool Customization

| Variable | Default | Allowed Values / Description |
| :--- | :--- | :--- |
| `MYWEBSEARCH_DATA_DIR` | `~/.my-websearch` | Root directory for configuration and persistent cookie files |
| `OPEN_WEBSEARCH_RESPONSE_CAP_BYTES` | `60000` | Maximum character limit returned to LLMs to prevent prompt context explosion |

> 💡 **Zero-Config Upgrades (Redundant Variables Removed)**:
> - **CORS Switches** (`ENABLE_CORS`/`CORS_ORIGIN`): CORS is **disabled by default**; enable it explicitly and restrict origins when browser clients need cross-origin access.
> - **Browser Backend**: raw CDP via `chrome-remote-interface`; `playwright-core` is no longer bundled. `PLAYWRIGHT_*` names and `SEARCH_MODE=playwright` remain as compatibility aliases.
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
npm test              # Run the Vitest suite (`npm test` prints the current file/test counts)
npm run check:docs    # Verify README env tables match docs/env-schema.json (edit the schema, then `npm run docs:env`)
npm run test:live     # Run bounded-concurrency live integration tests
npm run eval:live     # Run 23-case live STDIO JSON-RPC evaluation suite
```

### Acknowledgements

**Author: wtznicy**

This project evolved from **Open-WebSearch** (originally created by Aas-ee) — special thanks to the original author. Thanks also to:
- **[wreq-js](https://www.npmjs.com/package/wreq-js)** for native Chrome TLS/HTTP2 fingerprint impersonation
- **[Context7](https://context7.com)** for powering official documentation retrieval
- **[Mozilla Readability](https://github.com/mozilla/readability) & [Turndown](https://github.com/mixmark-io/turndown)** for content extraction and GFM Markdown formatting
