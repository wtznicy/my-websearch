# 发布到官方 MCP Registry 教程

> 目标平台：https://registry.modelcontextprotocol.io（Anthropic 官方的 MCP 服务器注册表，被各客户端默认查询）
> 服务器名：`io.github.wtznicy/my-websearch`

## 一、一次性准备（已完成，只做一次）

### 1. package.json 添加 mcpName

官方 Registry 通过 npm 包元数据验证所有权，`package.json` 必须包含：

```json
"mcpName": "io.github.wtznicy/my-websearch"
```

命名规则：GitHub 认证时必须以 `io.github.<你的GitHub用户名>/` 开头。

### 2. 生成 server.json（已放在仓库根目录）

发布清单，核心字段：`name`（必须与 mcpName 一致）、`version`（必须与 npm 已发布版本一致）、`packages`（npm 包信息 + 传输方式 + 环境变量）。

### 3. 下载 mcp-publisher 工具（Windows）

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe
```

## 二、每次发新版本流程（4 步）

### 第 1 步：bump 版本并发布 npm

```bash
# 修改 package.json 的 version 字段（如 1.0.1 → 1.0.2）
npm publish --registry=https://registry.npmjs.org/ --otp=<验证码>
```

⚠️ **必须带 `--registry=https://registry.npmjs.org/`**：本地 npm 配置了淘宝镜像，镜像只读，会报 `Public registration is not allowed`。

### 第 2 步：同步 server.json 版本号

编辑仓库根目录 `server.json`，把 `version` 和 `packages[0].version` 改成与 npm 一致的版本。

### 第 3 步：登录（设备码授权，需要浏览器）

```powershell
cd D:\Desktop\programming\MCP\my-websearch
$env:HTTPS_PROXY="http://127.0.0.1:7890"   # 国内网络需要，直连 GitHub 会超时
.\mcp-publisher.exe login github
```

终端会打印设备码，浏览器打开 `https://github.com/login/device`，输入设备码并用 wtznicy 账号授权。

### 第 4 步：发布并验证

```powershell
.\mcp-publisher.exe publish
```

验证：

```powershell
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=wtznicy"
```

看到 `io.github.wtznicy/my-websearch` 且版本正确即成功。

## 三、故障排查

| 报错 | 原因 | 解决 |
|---|---|---|
| `Public registration is not allowed` | npm publish 打到了淘宝镜像 | 加 `--registry=https://registry.npmjs.org/` |
| `EOTP` / 需要 one-time password | npm 账号开了 2FA | 手机验证器取码，加 `--otp=<码>` |
| `Failed to connect to github.com` | 国内直连 GitHub 超时 | 设置 `HTTPS_PROXY`/`HTTP_PROXY` 后重试 |
| `Invalid or expired Registry JWT token` | 登录过期 | 重新 `login github` |
| `You do not have permission to publish this server` | 命名空间与认证方式不匹配 | GitHub 认证时名字必须 `io.github.wtznicy/` 开头 |
| `Registry validation failed for package` | npm 包缺少 mcpName | 确认 package.json 的 `mcpName` 已随包发布（重新 npm publish） |

## 四、其他操作

### 删除/隐藏服务器版本

```powershell
# 删除某版本
.\mcp-publisher.exe status --status deleted --message "不再维护" io.github.wtznicy/my-websearch 1.0.1

# 删除全部版本
.\mcp-publisher.exe status --status deleted --all-versions --message "项目归档" io.github.wtznicy/my-websearch
```

### 自动化（可选）

官方支持 GitHub Actions OIDC 自动发布：每次 push tag 时自动跑 `mcp-publisher publish`，无需手动 login。见官方文档 `docs/github-actions.mdx`（https://github.com/modelcontextprotocol/registry/tree/main/docs/modelcontextprotocol-io/github-actions.mdx）。
