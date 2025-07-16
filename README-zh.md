# Open-WebSearch MCP 服务器

[![ModelScope](https://img.shields.io/badge/dynamic/json?label=ModelScope&url=https://www.modelscope.cn/api/v1/mcpServers/Aasee1/open-webSearch&query=$.Data.CallVolume&prefix=%E2%96%B2%20&color=orange)](https://www.modelscope.cn/mcp/servers/Aasee1/open-webSearch)
[![smithery badge](https://smithery.ai/badge/@Aas-ee/open-websearch)](https://smithery.ai/server/@Aas-ee/open-websearch)
![Version](https://img.shields.io/github/v/release/Aas-ee/open-websearch)
![License](https://img.shields.io/github/license/Aas-ee/open-websearch)
![Issues](https://img.shields.io/github/issues/Aas-ee/open-websearch)

[English](./README.md)

一个基于多引擎搜索结果的模型上下文协议(MCP)服务器，支持免费网络搜索，无需API密钥。

## 功能特性

- 使用多引擎搜索结果进行网络检索
    - bing
    - baidu
    - ~~linux.do~~ 暂不支持
    - csdn
    - duckduckgo
    - exa
    - brave
- 支持HTTP代理配置，轻松解决网络访问限制
- 无需API密钥或身份验证
- 返回带标题、URL和描述的结构化结果
- 可配置每次搜索返回的结果数量
- 可自定义默认搜索引擎
- 支持获取单篇文章内容
    - csdn

## TODO
- 支持~~Bing~~（已支持）,~~DuckDuckGo~~（已支持）,~~Exa~~（已支持）,~~Brave~~（已支持）,Google等搜索引擎
- 支持更多博客论坛、社交软件
- 优化文章内容提取功能，增加更多站点支持

## 安装指南

### 本地安装

1. 克隆或下载本仓库
2. 安装依赖项：
```bash
npm install
```
3. 构建服务器：
```bash
npm run build
```
4. 将服务器添加到您的MCP配置中：

**Cherry Studio:**
```json
{
  "mcpServers": {
    "web-search": {
      "name": "Web Search MCP",
      "type": "streamableHttp",
      "description": "Multi-engine web search with article fetching",
      "isActive": true,
      "baseUrl": "http://localhost:3000/mcp"
    }
  }
}
```

**VSCode版(Claude开发扩展):**
```json
{
  "mcpServers": {
    "web-search": {
      "transport": {
        "type": "streamableHttp",
        "url": "http://localhost:3000/mcp"
      }
    },
    "web-search-sse": {
      "transport": {
        "type": "sse",
        "url": "http://localhost:3000/sse"
      }
    }
  }
}
```

**Claude桌面版:**
```json
{
  "mcpServers": {
    "web-search": {
      "transport": {
        "type": "streamableHttp",
        "url": "http://localhost:3000/mcp"
      }
    },
    "web-search-sse": {
      "transport": {
        "type": "sse",
        "url": "http://localhost:3000/sse"
      }
    }
  }
}
```

### Docker部署

使用Docker Compose快速部署：

```bash
docker-compose up -d
```

或者直接使用Docker：
```bash
docker run -d --name web-search -p 3000:3000 -e ENABLE_CORS=true -e CORS_ORIGIN=* ghcr.io/aas-ee/open-web-search:latest
```

配置环境变量说明：

```bash
# 启用CORS (默认: false)
ENABLE_CORS=true

# CORS来源配置 (默认: *)
CORS_ORIGIN=*

# 默认搜索引擎 (可选值: bing, duckduckgo, exa, brave，默认: bing)
DEFAULT_SEARCH_ENGINE=duckduckgo

# 启用HTTP代理 (默认: false)
USE_PROXY=true

# 代理服务器URL (默认: http://127.0.0.1:10809)
PROXY_URL=http://your-proxy-server:port

# 服务器端口 (默认: 3000)
PORT=8080
```

然后在MCP客户端中配置：
```json
{
  "mcpServers": {
    "web-search": {
      "name": "Web Search MCP",
      "type": "streamableHttp",
      "description": "Multi-engine web search with article fetching",
      "isActive": true,
      "baseUrl": "http://localhost:3000/mcp"
    },
    "web-search-sse": {
      "transport": {
        "name": "Web Search MCP",
        "type": "sse",
        "description": "Multi-engine web search with article fetching",
        "isActive": true,
        "url": "http://localhost:3000/sse"
      }
    }
  }
}
```

## 使用说明

服务器提供三个工具：`search`、`fetchLinuxDoArticle`和`fetchCsdnArticle`。

### search工具使用说明

```typescript
{
  "query": string,        // 搜索查询词
  "limit": number,        // 可选：返回结果数量（默认：10）
  "engines": string[]     // 可选：要使用的引擎（bing,baidu,linuxdo,csdn,duckduckgo,exa,brave）默认bing
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "search",
  arguments: {
    query: "搜索内容",
    limit: 3,  // 可选参数
    engines: ["bing", "csdn", "duckduckgo", "exa", "brave"] // 可选参数，支持多引擎组合搜索
  }
})
```

返回示例：
```json
[
  {
    "title": "示例搜索结果",
    "url": "https://example.com",
    "description": "搜索结果的描述文本...",
    "source": "来源",
    "engine": "使用的引擎"
  }
]
```


### fetchCsdnArticle工具使用说明

用于获取CSDN博客文章的完整内容。

```typescript
{
  "url": string    // search 工具使用csdn查询出的url
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchCsdnArticle",
  arguments: {
    url: "https://blog.csdn.net/xxx/article/details/xxx"
  }
})
```

返回示例：
```json
[
  {
    "content": "示例搜索结果"
  }
]
```

### fetchLinuxDoArticle工具使用说明

用于获取Linux.do论坛文章的完整内容。

```typescript
{
  "url": string    // search 工具使用linuxdo查询出的url
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchLinuxDoArticle",
  arguments: {
    url: "https://xxxx.json"
  }
})
```

返回示例：
```json
[
  {
    "content": "示例搜索结果"
  }
]

```


## 使用限制

由于本工具通过爬取多引擎搜索结果实现，请注意以下重要限制：

1. **频率限制**：
    - 短时间内搜索次数过多可能导致使用的引擎暂时屏蔽请求
    - 建议：
        - 保持合理的搜索频率
        - 审慎使用limit参数
        - 必要时可在搜索间设置延迟

2. **结果准确性**：
    - 依赖对应引擎的HTML结构，可能随引擎改版失效
    - 部分结果可能缺失描述等元数据
    - 复杂搜索运算符可能无法按预期工作

3. **法律条款**：
    - 本工具仅限个人使用
    - 请遵守对应引擎的服务条款
    - 建议根据实际使用场景实施适当的频率限制

4. **搜索引擎配置**：
   - 可通过环境变量`DEFAULT_SEARCH_ENGINE`设置默认搜索引擎
   - 支持的引擎有：bing, duckduckgo, exa, brave
   - 当搜索特定网站内容时，会自动使用默认搜索引擎

5. **代理服务配置**：
   - 当某些搜索引擎在特定地区不可用时，可配置HTTP代理
   - 通过环境变量`USE_PROXY=true`启用代理
   - 使用`PROXY_URL`配置代理服务器地址

## 贡献指南

欢迎提交问题报告和功能改进建议！

### 贡献者指南

如果您想要fork本仓库并发布自己的Docker镜像，需要进行以下配置：

#### GitHub Secrets配置

要启用自动Docker镜像构建和发布功能，请在您的GitHub仓库设置中添加以下secrets（Settings → Secrets and variables → Actions）：

**必需的Secrets:**
- `GITHUB_TOKEN`: GitHub自动提供（无需设置）

**可选的Secrets（用于阿里云ACR）:**
- `ACR_REGISTRY`: 您的阿里云容器镜像服务URL（例如：`registry.cn-hangzhou.aliyuncs.com`）
- `ACR_USERNAME`: 您的阿里云ACR用户名
- `ACR_PASSWORD`: 您的阿里云ACR密码
- `ACR_IMAGE_NAME`: 您在ACR中的镜像名称（例如：`your-namespace/open-web-search`）

#### CI/CD工作流程

仓库包含一个GitHub Actions工作流程（`.github/workflows/docker.yml`），会自动：

1. **触发条件**：
    - 推送到`main`分支
    - 推送版本标签（`v*`）
    - 手动触发workflow

2. **构建并推送到**：
    - GitHub Container Registry (ghcr.io) - 始终启用
    - 阿里云容器镜像服务 - 仅在配置ACR secrets时启用

3. **镜像标签**：
    - `ghcr.io/您的用户名/open-web-search:latest`
    - `您的ACR地址/您的镜像名:latest`（如果配置了ACR）

#### Fork和发布步骤：

1. **Fork仓库**到您的GitHub账户
2. **配置secrets**（如果需要ACR发布）：
    - 进入您fork的仓库的Settings → Secrets and variables → Actions
    - 添加上面列出的ACR相关secrets
3. **推送更改**到`main`分支或创建版本标签
4. **GitHub Actions将自动构建并推送**您的Docker镜像
5. **使用您的镜像**，更新Docker命令：
   ```bash
   docker run -d --name web-search -p 3000:3000 -e ENABLE_CORS=true -e CORS_ORIGIN=* ghcr.io/您的用户名/open-web-search:latest
   ```

#### 注意事项：
- 如果您不配置ACR secrets，工作流程将只发布到GitHub Container Registry
- 确保您的GitHub仓库已启用Actions功能
- 工作流程会使用您的GitHub用户名（转换为小写）作为GHCR镜像名称

## Star History
如果项目对你有帮助，请考虑给个⭐ Star！

[![Star History Chart](https://api.star-history.com/svg?repos=Aas-ee/open-webSearch&type=Date)](https://www.star-history.com/#Aas-ee/open-webSearch&Date)
