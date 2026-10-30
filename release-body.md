## my-websearch 1.3.11

本版把搜索语法、MCP Prompts/Resources、文档兜底和站点提纯一起补齐，并在发版前修掉了三个新引入的回归。

### 新增

- **搜索语法跨引擎转译**：`search` 支持 `site:`、`filetype:`、`after:`、`before:`、`-排除词`。通用引擎重建原生查询，垂直/API 引擎只收纯关键词，最终按域名、后缀、排除词与 `publishedAt` 本地过滤。
- **MCP Prompts**：`deep-research`（多源研究 + 引用）与 `code-lookup`（官方文档 + 源码 + Release Notes）。
- **MCP Resources**：只读的 `websearch://cache/pages` / `websearch://cache/docs` 索引及 `{id}` 单条 Markdown，直接读取已缓存内容，不触发网络。
- **Maven Central 文档兜底**：`queryDocs` 支持 `groupId:artifactId[:version]`，从 Maven Search API + POM 的 SCM 地址解析仓库并抓 README。
- **Reddit 帖子提纯**：支持 old.reddit/shreddit，按分数格式化前 10 条评论。
- **知乎 / 博客园提纯**：剥离登录弹窗、推荐流、评论与页脚版权。
- **GitHub**：`releaseLimit` 控制 Release 数量；目录树自动过滤 lock/build 产物。

### 修复

- **Bing `site:` 误报错误**：cn.bing HTTP 忽略 `site:` 并让 Bing 自己抛 `engine_error`；现在 Bing 收纯关键词，`site:` 由本地后置过滤。
- **过滤后过早截断**：`after:`/`before:` 与 `timeRange` 在 `slice(limit)` 之前执行，避免日期过滤把可补位的后续结果提前丢掉。
- **目录树截断计数**：构建产物过滤后再计算 `isCapped`，header 不再虚报“显示 150 项”。
- **显式 `proxy.engines` 自动补齐 `yahoo` / `bing-news`**：旧白名单缺少这两个直连不可用的引擎时，不再静默超时/302。

### 工程

- 引擎目录去桶化：删除 11 个单行 `index.ts`、`searchGithub.ts`，DuckDuckGo 主文件统一命名。
- 测试目录分层：`runners/`、`legacy/`、`live/`、`vitest/`。
- `check:ci` 增加 manifest 版本/包名一致性校验。

gate：**93 文件 / 707 用例 / 16 个确定性脚本**。

完整变更见 [CHANGELOG](https://gitee.com/wtznicy/my-websearch/blob/main/CHANGELOG.md)。
