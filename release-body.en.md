## my-websearch 1.3.11

This release adds search operators, MCP Prompts/Resources, package-doc fallbacks, and site purifiers, plus three regressions found during release review.

### Added

- **Cross-engine search operators**: `search` now understands `site:`, `filetype:`, `after:`, `before:`, and `-exclude`; native engines get reconstructed queries, vertical/API engines get plain keywords, and results are post-filtered by domain, extension, exclusions, and `publishedAt`.
- **MCP Prompts**: `deep-research` (multi-source research with citations) and `code-lookup` (docs + source + release notes).
- **MCP Resources**: read-only `websearch://cache/pages` / `websearch://cache/docs` indexes and per-entry Markdown; cached content only, no extra network fetch.
- **Maven Central docs fallback**: `queryDocs` accepts `groupId:artifactId[:version]`, resolves the repository from the Maven Search API + POM SCM, and fetches the README.
- **Reddit purifier**: old.reddit/shreddit support with top-10 comments sorted by score.
- **Zhihu / Cnblogs purifiers**: strips login modals, recommendations, comments, and footer noise.
- **GitHub**: `releaseLimit` for releases; directory trees filter lock/build artifacts.

### Fixed

- **Bing `site:` false errors**: cn.bing HTTP ignores `site:` and makes Bing throw `engine_error`; Bing now receives plain keywords and `site:` is enforced locally.
- **Premature truncation**: `after:`/`before:` and `timeRange` now run before `slice(limit)`, so valid lower-ranked results are not discarded early.
- **Tree cap accounting**: `isCapped` is computed after artifact filtering; the header no longer overstates the shown count.
- **Explicit `proxy.engines` auto-completion**: legacy whitelists missing `yahoo` / `bing-news` no longer silently time out or get a 302.

### Engineering

- Removed 11 single-line engine barrels and `searchGithub.ts`; unified the DuckDuckGo filename.
- Test tree split into `runners/`, `legacy/`, `live/`, and `vitest/`.
- `check:ci` now verifies manifest versions/names.

Gate: **93 files / 707 tests / 16 deterministic scripts**.

Full changelog: [CHANGELOG.md](https://github.com/wtznicy/my-websearch/blob/main/CHANGELOG.md).
