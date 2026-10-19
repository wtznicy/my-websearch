# Changelog

All notable changes to `my-websearch` are documented in this file.

## [Unreleased]

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
