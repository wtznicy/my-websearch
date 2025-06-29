# Open-WebSearch MCP Server

[中文](./README-zh.md)

A Model Context Protocol (MCP) server based on multi-engine search results, supporting free web search without API keys.

## Features

- Multi-engine web search retrieval
    - bing
    - baidu
    - ~~linux.do~~ Not currently supported
    - csdn
- No API keys or authentication required
- Returns structured results with title, URL, and description
- Configurable number of results per search
- Support for fetching individual article content
    - csdn

## TODO
- Support ~~Bing~~ (already supported), Google and other search engines
- Support more blogs, forums, and social platforms

## Installation Guide

### Local Installation

1. Clone or download this repository
2. Install dependencies:
```bash
npm install
```
3. Build the server:
```bash
npm run build
```
4. Add the server to your MCP configuration:

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

**VSCode (Claude Development Extension):**
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

**Claude Desktop:**
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

### Docker Deployment

Deploy quickly using Docker Compose:

```bash
docker-compose up -d
```

Or use Docker directly:
```bash
docker run -d --name web-search -p 3000:3000 -e ENABLE_CORS=true -e CORS_ORIGIN=* ghcr.io/aas-ee/open-web-search:latest
```

Then configure in your MCP client:
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

## Usage Instructions

The server provides three tools: `search`, `fetchLinuxDoArticle`, and `fetchCsdnArticle`.

### search Tool Usage

```typescript
{
  "query": string,        // Search query
  "limit": number,        // Optional: Number of results to return (default: 5)
  "engines": string[]     // Optional: Engines to use (bing,baidu,linuxdo,csdn) default: bing
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "search",
  arguments: {
    query: "search content",
    limit: 3,  // Optional parameter
    engines: ["bing", "csdn"] // Optional parameter, supports multi-engine combined search
  }
})
```

Return example:
```json
[
  {
    "title": "Example search result",
    "url": "https://example.com",
    "description": "Description text of search result...",
    "source": "Source",
    "engine": "Engine used"
  }
]
```

### fetchCsdnArticle Tool Usage

Used to fetch complete content of CSDN blog articles.

```typescript
{
  "url": string    // URL returned from search tool using csdn query
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchCsdnArticle",
  arguments: {
    url: "https://blog.csdn.net/xxx/article/details/xxx"
  }
})
```

Return example:
```json
[
  {
    "content": "Example search result"
  }
]
```

### fetchLinuxDoArticle Tool Usage

Used to fetch complete content of Linux.do forum articles.

```typescript
{
  "url": string    // URL returned from search tool using linuxdo query
}
```

Usage example:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchLinuxDoArticle",
  arguments: {
    url: "https://xxxx.json"
  }
})
```

Return example:
```json
[
  {
    "content": "Example search result"
  }
]
```

## Usage Limitations

Since this tool is implemented by crawling multi-engine search results, please note the following important limitations:

1. **Rate Limiting**:
    - Too many searches in a short time may cause the engines to temporarily block requests
    - Recommendations:
        - Maintain reasonable search frequency
        - Use the limit parameter judiciously
        - Set delays between searches when necessary

2. **Result Accuracy**:
    - Depends on the HTML structure of corresponding engines, may fail with engine updates
    - Some results may lack metadata such as descriptions
    - Complex search operators may not work as expected

3. **Legal Terms**:
    - This tool is for personal use only
    - Please comply with the terms of service of corresponding engines
    - Recommend implementing appropriate rate limiting based on actual usage scenarios

## Contributing

Welcome to submit issue reports and feature improvement suggestions!
