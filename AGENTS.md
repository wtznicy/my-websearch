# AGENTS.md

给在本仓库工作的 AI 协作者的最小约定。

## 工作流默认动作（最重要）

用户提出改动，但**没有明确说「发版」或「推送」**时：

- ✅ 改代码 → 跑 `npm run check:ci` → **提交（commit）**
- ❌ **不推送**：不 `git push`、不打 tag、不建 release、不发 npm / 官方 Registry

只有用户明确说：

| 用户说 | 动作 |
|---|---|
| 「推送 / push」 | 提交 + 推送两个远端（gitee + github，直推，不靠镜像） |
| 「发版 / release / 发一版」 | 走完整发版流程（bump → 检查 → 双推 → 两端 Release → 用户发 npm/Registry） |
| 「改 / 修 / 加」 | 只提交，不推送 |

## 提交信息

`type(scope): 中文描述`，type 用 feat / fix / refactor / docs / chore / test / perf。

## 提交前

必须跑 `npm run check:ci`：`typecheck:strict` → `lint`（零告警）→ vitest → `build` → 16 个确定性自校验脚本。
任何一步红了先修，不要带红提交。

## 不要提交

`build/`、`node_modules/`、`.release-tokens.json`、`.agents/`、`*.log`、`mcp-publisher*` —— 均已在 `.gitignore` 里，提交时确认没有被 `git add -A` 带进去。

## 发版

本机 skill：`.agents/skills/mywebsearch-release/SKILL.md`（不入库）。
工具：`tools/release.mjs`（`bump` / `release` / `verify`），Release 直连 REST API，不依赖 gitee/github MCP。
**npm 与官方 MCP Registry 的发布由用户自己执行**（账号 2FA 需要交互式终端，AI 跑必然 EOTP）。
