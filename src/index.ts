#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setupTools } from './tools/setupTools.js';

async function main() {
  const server = new Server(
      { name: 'web-search', version: '0.1.0' },
      { capabilities: { tools: {} } }
  );

  // 统一设置所有工具
  setupTools(server);

  server.onerror = (err) => console.error('[MCP Error]', err);
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Web Search MCP server running on stdio');
}

main().catch(console.error);
