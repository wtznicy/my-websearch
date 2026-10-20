# Tools

These tool-selection notes apply after the `my-websearch` MCP capability is available in the current workspace.

## `search`

Use for:
- finding current information
- comparing multiple public sources
- locating candidate URLs before deeper reading

Returns:
- structured search results with `title`, `url`, `description`, `source`, `engine`

Good follow-up actions:
- fetch one or more result URLs with `fetchWebContent`
- fetch a repository with `fetchGithubContent`
- if Bing Playwright mode returns no results for a `site:` query, retry once without the `site:` prefix before assuming the search target is empty

## `fetchWebContent`

Use for:
- reading a specific public HTTP(S) page
- extracting article or documentation text from a known URL
- confirming details from a search result before summarizing

Notes:
- supports Markdown files and normal public pages
- **`focus`** targets a section without paying for the whole page. Default `focusMode: bm25` ranks paragraphs by relevance and keeps the best ones (it also matches multi-word focus terms that never appear as one literal phrase); `focusMode: window` keeps the older fixed ±2500-char window around the first literal match
- **`extract`** returns structured JSON instead of markdown using CSS selectors (`{baseSelector, fields:[{name, selector, type, attribute, fields, all}]}`), with no LLM in the loop. Prefer it over reading a long markdown dump when you only need a few fields from a list page. `selector: "@href"` reads an attribute of the current node
- **`selector`** scopes extraction to a CSS subtree and still returns markdown (code blocks and tables intact). Use it when auto-extraction grabs the wrong container. It concatenates every matched node, and **fails with `selector_not_found` rather than returning the whole page** — the hint lists containers the page actually has. Not combinable with `extract` (use `extract.baseSelector`) or `raw`
- **`retainLinks: 'text'`** keeps anchor text and drops URLs (measured -50% on list/index pages); `none` removes the link construct entirely. Images and code fences are untouched. Cannot be combined with `citations`
- **`citations`** rewrites inline links into numbered `[n]` markers plus a `## References` list with absolute URLs — use it when the answer must cite its sources
- `extract` needs an HTML page: it bypasses the page cache and the CSDN/Juejin/GitHub forwards, and errors on PDF/Markdown targets
- may fail on pages that require browser cookies or unusual TLS chains
- some pages may additionally require browser-assisted fallback; if the issue appears to be browser-only content or blocked request-mode access, check whether Playwright/browser support is available before assuming the fetch path itself is broken
- if the user wants cleaner extracted content or wants to preserve in-content links for follow-up multi-page research, prefer the optional Readability path for `fetch-web`; do not assume it is best for every page
- `FETCH_WEB_INSECURE_TLS` applies only here
- do not jump to TLS or environment explanations for an ordinary fetch failure; first try a better source URL, a more stable result, or a clearer page target
- do not assume arbitrary homepages or JS-heavy landing pages will yield readable article text; often it is better to search first and then fetch a more specific result page

## `fetchGithubContent` (formerly `fetchGithubReadme`)

Use for:
- a repository README, any single source file (`/blob/<ref>/<path>`), a directory tree (`/tree/<ref>/<path>`), an Issue, or a PR
- fast repository understanding before reading source files

Notes:
- pass a full GitHub/Gitee URL; `ref` may be a branch, tag, or commit
- one file or directory per call; this is not a whole-repo clone
- if a file path is wrong, the error lists sibling files and a ready-to-use `/blob/...` URL

Prefer this over `fetchWebContent` when the input is clearly a repository URL.
