// tools/setupTools.ts
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { fetchLinuxDoArticle } from '../engines/linuxdo/fetchLinuxDoArticle.js';
import { searchBaidu } from '../engines/baidu.js';
import { searchBing } from '../engines/bing.js';
import { SearchResult } from '../types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { searchLinuxDo } from "../engines/linuxdo/linuxdo.js";

const isValidSearchArgs = (args: any): args is { query: string; limit?: number; engines: string[] } =>
    typeof args === 'object' && args !== null && typeof args.query === 'string' &&
    (args.limit === undefined || typeof args.limit === 'number');

const isValidFetchArgs = (args: any): args is { url: string } =>
    typeof args === 'object' && args !== null && typeof args.url === 'string';

export const setupTools = (server: Server) => {
    // 统一的工具列表处理器
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'search',
                description: 'Search the web using multiple engines (e.g., Baidu, Bing, Linuxdo) with no API key required',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query' },
                        limit: { type: 'number', description: 'Maximum number of results to return (default: 5)', minimum: 1, maximum: 20, default: 5 },
                        engines: {
                            type: 'array',
                            description: 'Search engines to use (e.g., ["baidu", "bing", "linuxdo"])',
                            items: {
                                type: 'string',
                                enum: ['baidu', 'bing', 'linuxdo']
                            },
                            default: ['bing']
                        },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'fetchLinuxDoArticle',
                description: 'Fetch full article content from a linux.do post URL',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'URL of linux.do article post (must end with .json, e.g., https://linux.do/t/742055.json?track_visit=true&forceLoad=true)'
                        }
                    },
                    required: ['url']
                }
            }
        ]
    }));

    // 统一的工具调用处理器
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        switch (name) {
            case 'search': {
                if (!isValidSearchArgs(args)) {
                    throw new McpError(ErrorCode.InvalidParams, 'Invalid search arguments');
                }

                const { query, limit = 5, engines } = args;
                const engineCount = engines.length;
                const base = Math.floor(limit / engineCount);
                const rem = limit % engineCount;

                const tasks: Promise<SearchResult[]>[] = [];

                engines.forEach((engine, i) => {
                    const engineLimit = base + (i < rem ? 1 : 0);
                    switch (engine) {
                        case 'baidu': tasks.push(searchBaidu(query, engineLimit)); break;
                        case 'bing': tasks.push(searchBing(query, engineLimit)); break;
                        case 'linuxdo': tasks.push(searchLinuxDo(query, engineLimit)); break;
                        default: break;
                    }
                });

                const results = (await Promise.all(tasks)).flat().slice(0, limit);

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(results, null, 2),
                    }]
                };
            }

            case 'fetchLinuxDoArticle': {
                if (!isValidFetchArgs(args)) {
                    throw new McpError(ErrorCode.InvalidParams, 'Invalid fetchLinuxDoArticle arguments');
                }

                const { url } = args;
                const result = await fetchLinuxDoArticle(url);

                return {
                    content: [
                        {
                            type: 'text',
                            text: result.content
                        }
                    ]
                };
            }

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    });
};
