# Open-WebSearch MCP Server

[中文版本](./README-zh.md)

A Model Context Protocol (MCP) server based on multi-engine search results, supporting free web searches without requiring API keys.

## Features

- Uses multi-engine search results for web retrieval
- No API keys or authentication required
- Returns structured results with titles, URLs, and descriptions
- Configurable number of results per search

## TODO
- Support search engines such as Bing, Google, etc.
- Support blogs, forums, and social media platforms

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

## Usage

The server provides a single tool named `search` that accepts the following parameters:

```typescript
{
  "query": string,    // The search query
  "limit": number,     // Optional: Number of results to return (default: 5)
  "engines": string[]  // Optional: the search engine to use. Available options are `bing` and `baidu`. Defaults to `bing`.
}
```

Example usage:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "search",
  arguments: {
    query: "your search query",
    limit: 3,  // optional
    engines: ["bing"] // optional
  }
})
```

Example response:
```json
[
  {
    "title": "Example Search Result",
    "url": "https://example.com",
    "description": "Description of the search result...",
    "source": "Source",
    "engine": "Engine to use"
  }
]
```

## Limitations

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
