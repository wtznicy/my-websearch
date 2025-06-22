# Open-WebSearch MCP Server

[中文版本](./README-zh.md)

A Model Context Protocol (MCP) server based on multi-engine search results, supporting free web searches without requiring API keys.

## Features

- Uses multi-engine search results for web retrieval
  - bing
  - baidu
  - linux.do
- No API keys or authentication required
- Returns structured results with titles, URLs, and descriptions
- Configurable number of results per search

## TODO
- Support for ~~Bing~~ (already supported), Google, and other search engines
- Support for more blogs, forums, and social platforms

## Installation

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

For VSCode (Claude Dev Extension):
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

For Claude Desktop:
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

## Usage Instructions

The server provides a tool named `search` and a tool named `fetchLinuxDoArticle`, which accept the following parameters:

### search Tool Usage Instructions

```typescript
{
  "query": string,    // Search query term
  "limit": number,     // Optional: Number of results to return (default: 5)
  "engines": string[]     // Optional: Engines to use (bing,baidu,linuxdo) default bing
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
    engines: ["bing"] // Optional parameter
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

### fetchLinuxDoArticle Tool Usage Instructions


```typescript
{
  "url": string    // URL obtained from linuxdo search using the search tool
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

Since this tool relies on scraping search results from multiple engines, please be aware of the following important limitations:

1. **Rate Limiting**: 
   - Performing too many searches in a short period may result in temporary blocking by the selected engine.
   - Recommendations:
     - Maintain a reasonable search frequency
     - Use the limit parameter cautiously
     - Introduce delays between searches if necessary

2. **Result Accuracy**:
   - Parsing depends on the HTML structure of each engine, which may change and cause failures
   - Some results might be missing descriptions or other metadata
   - Complex search operators may not work as expected

3. **Legal Considerations**:
   - This tool is intended for personal use
   - Please comply with the terms of service of each search engine
   - Consider implementing appropriate rate limiting for your use case

## Contributing

Feel free to submit issues and enhancement requests!
