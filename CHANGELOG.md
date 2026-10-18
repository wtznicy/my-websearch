# Changelog

All notable changes to `my-websearch` are documented in this file.

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
