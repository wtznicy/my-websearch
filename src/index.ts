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
  engine: string;
}

const isValidSearchArgs = (args: any): args is { query: string; limit?: number; engines: string[] } =>
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
          description: 'Search the web using multiple engines (e.g., Baidu, Bing) with no API key required',
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
                maximum: 20,
              },
              engines: {
                type: 'array',
                description: 'Search engines to use (e.g., ["baidu", "bing"])',
                items: {
                  type: 'string',
                  enum: ['baidu', 'bing'], // 可扩展
                },
                default: ['bing'],
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
      const limit = request.params.arguments.limit || 5;
      const engines = request.params.arguments.engines || ['bing'];

      try {
        const results = await this.performSearch(query, limit,engines);
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

  private async performSearch(query: string, limit: number, engines: string[]): Promise<SearchResult[]> {
    const engineCount = engines.length;
    if (engineCount === 0) return [];

    // 1. 计算每个引擎的分配 limit
    const baseLimit = Math.floor(limit / engineCount);
    const remainder = limit % engineCount;

    const tasks: Promise<SearchResult[]>[] = [];

    for (let i = 0; i < engines.length; i++) {
      const engine = engines[i].toLowerCase();
      const engineLimit = baseLimit + (i < remainder ? 1 : 0); // 分配多余的那几个

      switch (engine) {
        case 'baidu':
          tasks.push(this.searchBaidu(query, engineLimit));
          break;
        case 'bing':
          tasks.push(this.searchBing(query, engineLimit));
          break;
        default:
          console.warn(`⚠️ 未知搜索引擎: ${engine}`);
          break;
      }
    }

    const results = await Promise.all(tasks);
    const flatResults = results.flat();

    // // 去重（根据 URL）
    // const uniqueResults = Array.from(new Map(flatResults.map(item => [item.url, item])).values());

    return flatResults.slice(0, limit); // 确保总数不超过原始 limit
  }

  private async searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
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
              engine: 'baidu'
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

  private async searchBing(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 0;

    while (allResults.length < limit) {
      const response = await axios.get('https://cn.bing.com/search', {
        params: {
          q: query,
          first: 1 + pn * 10
        },
        headers: {
          "authority": "www.bing.com",
          "ect": "3g",
          "pragma": "no-cache",
          "sec-ch-ua-arch": "\"x86\"",
          "sec-ch-ua-bitness": "\"64\"",
          "sec-ch-ua-full-version": "\"112.0.5615.50\"",
          "sec-ch-ua-full-version-list": "\"Chromium\";v=\"112.0.5615.50\", \"Google Chrome\";v=\"112.0.5615.50\", \"Not:A-Brand\";v=\"99.0.0.0\"",
          "sec-ch-ua-model": "\"\"",
          "sec-ch-ua-platform-version": "\"15.0.0\"",
          "sec-fetch-user": "?1",
          "upgrade-insecure-requests": "1",
          "Cookie": "MUID=3727DBB14FD763511D80CDBD4ED262EF; MSPTC=5UlNf4UsLqV53oFqqdHiR26FwDDL8zSW3kC74kIJQfM; _EDGE_S=SID=132F08F578E06F832D931EE779E16E2D; MUIDB=3727DBB14FD763511D80CDBD4ED262EF; SRCHD=AF=NOFORM; SRCHUID=V=2&GUID=B3AFD0E41DB649E39803C690946C3B65&dmnchg=1; ak_bmsc=578AE2B7DA55FA9F332ADCDFBA0B9B64~000000000000000000000000000000~YAAQZCg0F9XLkYGXAQAAjywwkhxcD6Pm2nguBmpB14hnmCR3kz9Mfau5cZ7pwHxdU2Uog9+6hOkBmzpOV3UoTOhi52nB725xM7zN90mRDv0zQtJdO/llaKlt2zqTmB4F5kd+GzPjXLAN4Zmj4KwpAjLK1T4TexH/9WlQTkRamdJTKuR47IZWHHebqsbNqHoYncHhxICO9Rnu51vhlps/rrhPBtgPgbrQnDfr6YzAQWmSqc5g9hk03sM9nnWUyVbRV0ZVsgke7BCYX5V1JD5L0Zf8/FWdntBpjpd2IcmehBz38ChGThPrBEWNCZQbCS6lE4OaQanrrdmBHf/r5YEf2LeIqZy0bJGIiSQaSh6d7KFO2haTQk/JscZAs+V5kNsAOxIGreRve+E=; _UR=QS=0&TQS=0&Pn=0; BFBUSR=BFBHP=0; SRCHUSR=DOB=20250621&DS=1; _Rwho=u=d&ts=2025-06-21; ipv6=hit=1750507922628&t=4; BFPRResults=FirstPageUrls=C5E678E900F98310F0D3DB1F3EB96D99%2CB5A20FAE72B0C3019A56409EAC7AF3FB%2C7A44A77FF42EDF11CC9BF5CFE08B179A%2C6ED615E5E634BD5AFC7BB2A0A77F8FF8%2CA993E7AAF4890BEC06882621CA376D00%2C49CF0FC3C203D5E918A76258506B0CF4%2C7F03D5026C1D046F66B11D525095BF8B%2C058BB67A6B7F15E58D3A19B897BC57F8%2C1B886024FDE703428D24A41AFA1E62AF%2C5A8B56DC0AE03A8B94643DEA2A22DBAC&FPIG=05F126AA95514CF5AD5E33E4AEBA474D; _HPVN=CS=eyJQbiI6eyJDbiI6MSwiU3QiOjAsIlFzIjowLCJQcm9kIjoiUCJ9LCJTYyI6eyJDbiI6MSwiU3QiOjAsIlFzIjowLCJQcm9kIjoiSCJ9LCJReiI6eyJDbiI6MSwiU3QiOjAsIlFzIjowLCJQcm9kIjoiVCJ9LCJBcCI6dHJ1ZSwiTXV0ZSI6dHJ1ZSwiTGFkIjoiMjAyNS0wNi0yMVQwMDowMDowMFoiLCJJb3RkIjowLCJHd2IiOjAsIlRucyI6MCwiRGZ0IjpudWxsLCJNdnMiOjAsIkZsdCI6MCwiSW1wIjoxNSwiVG9ibiI6MH0=; _C_ETH=1; _RwBf=r=0&ilt=15&ihpd=1&ispd=14&rc=36&rb=0&rg=200&pc=36&mtu=0&rbb=0&clo=0&v=15&l=2025-06-21T07:00:00.0000000Z&lft=0001-01-01T00:00:00.0000000&aof=0&ard=0001-01-01T00:00:00.0000000&rwdbt=0&rwflt=0&rwaul2=0&g=&o=2&p=&c=&t=0&s=0001-01-01T00:00:00.0000000+00:00&ts=2025-06-21T11:36:08.7064260+00:00&rwred=0&wls=&wlb=&wle=&ccp=&cpt=&lka=0&lkt=0&aad=0&TH=&cid=0&gb=; _SS=SID=132F08F578E06F832D931EE779E16E2D&R=36&RB=0&GB=0&RG=200&RP=36; SRCHHPGUSR=SRCHLANG=zh-Hans&IG=63A0A44F5D2F4499AD165A366D073C03&DM=0&BRW=N&BRH=T&CW=1202&CH=1289&SCW=1185&SCH=2279&DPR=1.0&UTC=480&HV=1750505768&HVE=notFound&WTS=63886101120&PV=15.0.0&PRVCW=1202&PRVCH=1289&EXLTT=13; SRCHHPGUSR=SRCHLANG=en&IG=9A53F826E9C9432497327CA995144E14&DM=0&BRW=N&BRH=T&CW=1202&CH=1289&SCW=1185&SCH=2279&DPR=1.0&UTC=480&HV=1750505768&HVE=notFound&WTS=63886101120&PV=15.0.0&PRVCW=1202&PRVCH=1289&EXLTT=13",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Host": "cn.bing.com",
          "Connection": "keep-alive"
        }
      });

      const $ = cheerio.load(response.data);
      const results: SearchResult[] = [];

      $('#b_content').children()
          .find('#b_results').children()
          .each((i, element) => {
            const titleElement = $(element).find('h2');
            const linkElement = $(element).find('a');
            const snippetElement = $(element).find('p').first();

            if (titleElement.length && linkElement.length) {
              const url = linkElement.attr('href');
              if (url && url.startsWith('http')) {

                const sourceElement = $(element).find('.b_tpcn');
                results.push({
                  title: titleElement.text(),
                  url: url,
                  description: snippetElement.text().trim() || '',
                  source: sourceElement.text().trim() || '',
                  engine: 'bing'
                });
              }
            }
      });

      allResults = allResults.concat(results);

      if (results.length === 0) {
        console.log('⚠️ No more results, ending early....');
        break;
      }

      pn += 1;
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
