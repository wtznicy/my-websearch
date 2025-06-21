#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as cheerio from 'cheerio';

interface SearchResult {
  title: string;
  url: string;
  description: string;
  source: string;
}

const isValidSearchArgs = (args: any): args is { query: string; limit?: number } =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.query === 'string' &&
  (args.limit === undefined || typeof args.limit === 'number');

class WebSearchServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'web-search',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search',
          description: 'Search the web using Baidu (no API key required)',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results to return (default: 5)',
                minimum: 1,
                maximum: 10,
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'search') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!isValidSearchArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid search arguments'
        );
      }

      const query = request.params.arguments.query;
      const limit = Math.min(request.params.arguments.limit || 5, 10);

      try {
        const results = await this.performSearch(query, limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: 'text',
                text: `Search error: ${error.message}`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  private async performSearch(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 0;

    while (allResults.length < limit) {
      const response = await axios.get('https://www.baidu.com/s', {
        params: {
          wd: query,
          pn: pn.toString(),
          ie: "utf-8",
          mod: "1",
          isbd: "1",
          isid: "f7ba1776007bcf9e",
          oq: query,
          tn: "88093251_62_hao_pg",
          usm: "1",
          fenlei: "256",
          rsv_idx: "1",
          rsv_pq: "f7ba1776007bcf9e",
          rsv_t: "8179fxGiNMUh/0dXHrLsJXPlKYbkj9S5QH6rOLHY6pG6OGQ81YqzRTIGjjeMwEfiYQTSiTQIhCJj",
          bs: query,
          rsv_sid: undefined,
          _ss: "1",
          f4s: "1",
          csor: "5",
          _cr1: "30385",
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      const results: SearchResult[] = [];

      $('#content_left').children().each((i, element) => {
        const titleElement = $(element).find('h3');
        const linkElement = $(element).find('a');
        const snippetElement = $(element).find('.cos-row').first();

        if (titleElement.length && linkElement.length) {
          const url = linkElement.attr('href');
          if (url && url.startsWith('http')) {
            const snippetElementBaidu = $(element).find('.c-font-normal.c-color-text').first();
            const sourceElement = $(element).find('.cosc-source');
            results.push({
              title: titleElement.text(),
              url: url,
              description: snippetElementBaidu.attr('aria-label') || snippetElement.text().trim() || '',
              source: sourceElement.text().trim() || '',
            });
          }
        }
      });

      allResults = allResults.concat(results);

      if (results.length === 0) {
        console.log('⚠️ No more results, ending early....');
        break;
      }

      pn += 10;
    }

    return allResults.slice(0, limit); // 截取最多 limit 个
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Web Search MCP server running on stdio');
  }
}

const server = new WebSearchServer();
server.run().catch(console.error);
