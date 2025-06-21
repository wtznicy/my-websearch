# Open-WebSearch MCP 服务器

[English](./README.md)

一个基于百度搜索结果的模型上下文协议(MCP)服务器，支持免费网络搜索，无需API密钥。

## 功能特性

- 使用百度搜索结果进行网络检索
- 无需API密钥或身份验证
- 返回带标题、URL和描述的结构化结果
- 可配置每次搜索返回的结果数量

## TODO
- 支持Bing,Google等搜索引擎
- 支持博客论坛、社交软件

## 安装指南

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

VSCode版(Claude开发扩展)：
```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/path/to/web-search/build/index.js"]
    }
  }
}
```

Claude桌面版：
```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/path/to/web-search/build/index.js"]
    }
  }
}
```

## 使用说明

服务器提供一个名为`search`的工具，接受以下参数：

```typescript
{
  "query": string,    // 搜索查询词
  "limit": number     // 可选：返回结果数量（默认：5）
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "search",
  arguments: {
    query: "搜索内容",
    limit: 3  // 可选参数
  }
})
```

返回示例：
```json
[
  {
    "title": "示例搜索结果",
    "url": "https://example.com",
    "description": "搜索结果的描述文本..."
  }
]
```

## 使用限制

由于本工具通过爬取百度搜索结果实现，请注意以下重要限制：

1. **频率限制**：
    - 短时间内搜索次数过多可能导致百度暂时屏蔽请求
    - 建议：
        - 保持合理的搜索频率
        - 审慎使用limit参数
        - 必要时可在搜索间设置延迟

2. **结果准确性**：
    - 依赖百度HTML结构，可能随百度改版失效
    - 部分结果可能缺失描述等元数据
    - 复杂搜索运算符可能无法按预期工作

3. **法律条款**：
    - 本工具仅限个人使用
    - 请遵守百度服务条款
    - 建议根据实际使用场景实施适当的频率限制

## 贡献指南

欢迎提交问题报告和功能改进建议！
