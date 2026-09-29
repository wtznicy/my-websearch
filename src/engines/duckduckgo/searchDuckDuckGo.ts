import axios from 'axios';
import * as cheerio from 'cheerio';
import {SearchResult} from "../../types.js";
import {buildAxiosRequestOptions} from "../../utils/httpRequest.js";
import { BROWSER_USER_AGENT } from '../../utils/constants.js';
import { assertOverseasEngineUsable } from '../../utils/overseasProbe.js';

const CHROME_133_SEC_CH_UA = '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"';

export function isTrustedDuckDuckGoPreloadUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'links.duckduckgo.com'
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/d.js';
  } catch {
    return false;
  }
}

/** 从脚本里取出 `DDG.deep.initialize(<表达式>, false)` 的第一个参数表达式 */
function extractInitializeExpression(scriptText: string): string | null {
  const match = scriptText.match(/DDG\s*\.\s*deep\s*\.\s*initialize\s*\(([\s\S]*?)\)\s*;/);
  if (!match?.[1]) {
    return null;
  }
  // 参数形如 `<表达式>, false`：按顶层逗号切开取第一段
  const args = match[1];
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/**
 * 把 initialize 的参数表达式拆成「前缀 + 累加变量 + 后缀」。
 * 只接受"字符串字面量与单个标识符用 + 连接"的形状，其它一律返回 null（宁可不解，也不猜）。
 */
function splitInitializeExpression(expression: string): { prefix: string; accumulator: string | null; suffix: string } {
  const parts: Array<{ literal: string } | { identifier: string }> = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i] ?? '';
    if (ch === '+' || /\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let value = '';
      i += 1;
      while (i < expression.length && expression[i] !== quote) {
        if (expression[i] === '\\') {
          value += expression[i] + (expression[i + 1] ?? '');
          i += 2;
          continue;
        }
        value += expression[i];
        i += 1;
      }
      if (i >= expression.length) {
        return { prefix: '', accumulator: null, suffix: '' };
      }
      i += 1;
      parts.push({ literal: value });
      continue;
    }
    const identifierMatch = /^[A-Za-z_$][\w$]*/.exec(expression.slice(i));
    if (identifierMatch) {
      parts.push({ identifier: identifierMatch[0] });
      i += identifierMatch[0].length;
      continue;
    }
    // 数字/括号/函数调用等未预期的形状 → 放弃静态解析
    return { prefix: '', accumulator: null, suffix: '' };
  }

  const identifiers = parts.filter((part): part is { identifier: string } => 'identifier' in part);
  const firstIdentifier = identifiers[0];
  if (identifiers.length !== 1 || !firstIdentifier) {
    return { prefix: '', accumulator: null, suffix: '' };
  }
  const accumulator = firstIdentifier.identifier;
  const accumulatorIndex = parts.findIndex((part) => 'identifier' in part);
  const prefix = parts.slice(0, accumulatorIndex).map((part) => ('literal' in part ? part.literal : '')).join('');
  const suffix = parts.slice(accumulatorIndex + 1).map((part) => ('literal' in part ? part.literal : '')).join('');
  return { prefix, accumulator, suffix };
}

/** 累加变量的初始值（`let jsa = 973;`） */
function extractInitialValue(scriptText: string, accumulator: string): number | null {
  const escaped = accumulator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = scriptText.match(new RegExp(String.raw`(?:let|var|const)\s+${escaped}\s*=\s*(\d+)\b`));
  return match?.[1] ? Number(match[1]) : null;
}

type ChallengeHelper =
  | { kind: 'multiply'; factor: number }
  | { kind: 'addConstant'; delta: number }
  | { kind: 'addLength'; length: number }
  | { kind: 'unknown' };

/** HTML5 规范解析后的 innerHTML 长度（与浏览器一致：cheerio 会补全缺失的闭合标签） */
function serializedFragmentLength(fragment: string): number {
  const $ = cheerio.load(`<div>${fragment}</div>`, null, false);
  return ($('div').first().html() || '').length;
}

/** 提取挑战脚本里 `let NAME = function(num){...}` 形式的 helper 及其语义 */
function extractChallengeHelpers(scriptText: string): Map<string, ChallengeHelper> {
  const helpers = new Map<string, ChallengeHelper>();
  const definitionRe = /(?:let|var|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*?)\};/g;
  let match: RegExpExecArray | null;
  while ((match = definitionRe.exec(scriptText)) !== null) {
    const [, name, param, body] = match;
    if (!name || !param || !body) {
      continue;
    }

    const multiply = body.match(new RegExp(String.raw`return\s+${param}\s*\*\s*(\d+)`));
    if (multiply?.[1]) {
      helpers.set(name, { kind: 'multiply', factor: Number(multiply[1]) });
      continue;
    }
    const addConstant = body.match(new RegExp(String.raw`return\s+${param}\s*\+\s*(\d+)`));
    if (addConstant?.[1]) {
      helpers.set(name, { kind: 'addConstant', delta: Number(addConstant[1]) });
      continue;
    }

    // 「把片段写进 innerHTML 后 return num + el.innerHTML.length」——片段的规范化长度即增量
    const mutableFragment = body.match(/innerHTML\s*=\s*([`'"])([\s\S]*?)\1/);
    const addsLength = new RegExp(String.raw`return\s+${param}\s*\+\s*[A-Za-z_$][\w$]*\s*\.\s*innerHTML\s*\.\s*length`).test(body);
    if (mutableFragment?.[2] !== undefined && addsLength && !mutableFragment[2].includes('${')) {
      helpers.set(name, { kind: 'addLength', length: serializedFragmentLength(mutableFragment[2]) });
      continue;
    }

    helpers.set(name, { kind: 'unknown' });
  }
  return helpers;
}

/** 按脚本里出现的顺序抽取 `acc = helper(acc)` / `acc = acc * K` / `acc = K + acc` 等单位运算链 */
function extractOperationChain(
  scriptText: string,
  accumulator: string,
  helpers: Map<string, ChallengeHelper>
): Array<(value: number) => number> | null {
  if (!helpers.size) {
    return [];
  }
  const escaped = accumulator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const statementRe = new RegExp(
    [
      String.raw`\b${escaped}\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*${escaped}\s*\)`,
      String.raw`\b${escaped}\s*=\s*${escaped}\s*([*+])\s*(\d+)`,
      String.raw`\b${escaped}\s*=\s*(\d+)\s*([*+])\s*${escaped}`
    ].join('|'),
    'g'
  );

  const operations: Array<(value: number) => number> = [];
  let match: RegExpExecArray | null;
  while ((match = statementRe.exec(scriptText)) !== null) {
    const [, helperName, rightOperator, rightOperand, leftOperand, leftOperator] = match;
    if (helperName) {
      const helper = helpers.get(helperName);
      if (!helper || helper.kind === 'unknown') {
        return null;
      }
      if (helper.kind === 'multiply') {
        const factor = helper.factor;
        operations.push((value) => value * factor);
      } else if (helper.kind === 'addConstant') {
        const delta = helper.delta;
        operations.push((value) => value + delta);
      } else {
        const length = helper.length;
        operations.push((value) => value + length);
      }
      continue;
    }
    const operator = rightOperator ?? leftOperator;
    const operand = Number(rightOperand ?? leftOperand);
    if (!operator || !Number.isFinite(operand)) {
      return null;
    }
    operations.push((value) => (operator === '*' ? value * operand : value + operand));
  }
  return operations;
}

/**
 * 求解 DuckDuckGo links.duckduckgo.com/d.js 的 `window.execDeep`（`isJsaChallenge`）挑战。
 *
 * **静态解析，不执行远端脚本（无 eval、无 node:vm）**。挑战脚本的形状固定为三部分：
 *   ① 累加变量（`let jsa = 973;`）；
 *   ② 若干纯函数 helper——要么 `return num * K`，要么「把 HTML 片段写进 el.innerHTML、
 *      再 `return num + el.innerHTML.length`」；
 *   ③ 一串 `jsa = helper(jsa)`，最后 `DDG.deep.initialize('/d.js?…&jsa_hash=…&jsa=' + jsa, false)`。
 * 片段长度用 cheerio（HTML5 规范解析，实测与浏览器/jsdom 逐字节一致）算出，运算链由本文件的小解释器执行。
 *
 * 为什么不 eval：此前是 `vm.runInNewContext(scriptText, sandbox)`，而 sandbox 里传的是宿主对象/宿主函数，
 * 脚本可经 `window.constructor.constructor('return process')()` 爬回宿主 realm 执行任意代码
 * （2026-09-26 实测确认，500ms 超时拦不住）。静态解析不执行任何远端代码；形状不匹配就返回 null，
 * 外层按"挑战未破"优雅失败（不重试、交给级联）。
 */
export function solveDuckDuckGoJsaChallenge(scriptText: string): string | null {
  if (!scriptText || !scriptText.includes('isJsaChallenge') || !scriptText.includes('window.execDeep')) {
    return null;
  }

  try {
    const expression = extractInitializeExpression(scriptText);
    if (!expression) {
      return null;
    }
    const { prefix, accumulator, suffix } = splitInitializeExpression(expression);
    if (!accumulator) {
      return null;
    }
    const initialValue = extractInitialValue(scriptText, accumulator);
    if (initialValue === null) {
      return null;
    }
    const helpers = extractChallengeHelpers(scriptText);
    const operations = extractOperationChain(scriptText, accumulator, helpers);
    if (!operations || operations.length === 0) {
      return null;
    }

    let value = initialValue;
    for (const operation of operations) {
      value = operation(value);
    }

    const resolvedUrl = new URL(`${prefix}${value}${suffix}`, 'https://links.duckduckgo.com').toString();
    if (!isTrustedDuckDuckGoPreloadUrl(resolvedUrl) || resolvedUrl.includes('&jsa=-1')) {
      return null;
    }

    return resolvedUrl;
  } catch {
    return null;
  }
}

/**
 * preload 路径（JSONP）返回的 title/description/source 是 HTML 片段：
 * 含 <b> 高亮标签和 &#x27; 等实体（如 "<b>MCP</b> is... Whether you&#x27;re"），
 * 统一转纯文本（剥标签 + 解码实体），与 HTML 路径的 cheerio .text() 结果保持一致。
 */
function cleanHighlightedText(html: string): string {
  if (!html) {
    return '';
  }
  return cheerio.load(html).root().text().trim();
}

/**
 * 解析 DuckDuckGo preload 路径（links.duckduckgo.com/d.js）返回的 JSONP 文本。
 * 提取并映射为 SearchResult；导航项（item.n）跳过。文本不可解析时返回空数组
 * （由调用方决定终止分页）。
 */
export function parseDuckDuckGoJsonpPayload(jsonpText: string): SearchResult[] {
  const jsonpMatch = jsonpText.match(/DDG\.pageLayout\.load\('d',\s*(\[.*?\])\s*\);/s);
  if (!jsonpMatch || !jsonpMatch[1]) {
    return [];
  }

  try {
    const jsonData = JSON.parse(jsonpMatch[1]);
    const results: SearchResult[] = [];
    type DdgJsonpItem = { n?: unknown; t?: string; u?: string; a?: string; i?: string; sn?: string };
    jsonData.forEach((item: DdgJsonpItem) => {
      // Exclude navigation items
      if (item.n) {
        return;
      }
      results.push({
        title: cleanHighlightedText(item.t || ''),
        url: item.u || '',
        description: cleanHighlightedText(item.a || ''),
        source: cleanHighlightedText(item.i || item.sn || ''),
        engine: 'duckduckgo'
      });
    });
    return results;
  } catch (error) {
    console.warn('解析JSONP数据失败:', error);
    return [];
  }
}

export type DuckDuckGoHtmlParseResult = {
  results: SearchResult[];
  /** 本页原始结果卡数量（含广告/被过滤项），用于分页 offset 计算 */
  rawCount: number;
};

/**
 * 解析 DuckDuckGo HTML 路径（html.duckduckgo.com/html/）的结果页。
 * 广告卡（.result--ad）与已见 URL 会被过滤；rawCount 供调用方计算下一页 offset。
 */
export function parseDuckDuckGoHtmlResults(html: string, maxResults: number, seenUrls: Set<string>): DuckDuckGoHtmlParseResult {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  let rawCount = 0;

  $('div.result').each((_, el) => {
    rawCount += 1;
    if (results.length >= maxResults) {
      return false;
    }

    const titleEl = $(el).find('a.result__a');
    const snippetEl = $(el).find('.result__snippet');
    const title = titleEl.text().trim();
    const url = titleEl.attr('href') || '';
    const description = snippetEl.text().trim();
    const sourceEl = $(el).find('.result__url');
    const source = sourceEl.text().trim();

    if (title && url && !$(el).hasClass('result--ad') && !seenUrls.has(url)) {
      seenUrls.add(url);
      results.push({
        title,
        url,
        description,
        source,
        engine: 'duckduckgo'
      });
    }
  });

  return { results, rawCount };
}


/**
 * Search DuckDuckGo and return results
 * @param query Search query
 * @param limit Maximum number of results
 * @returns Array of search results
 */
export async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  // 未配置代理时先探测直连可达性：不可达立即报"需要代理"，避免直连挂 15s 超时拖累整次搜索
  await assertOverseasEngineUsable('duckduckgo');
  let preloadError: unknown = null;
  // Try using the preloaded URL method
  try {
    const results = await searchDuckDuckGoPreloadUrl(query, limit);
    if (results.length > 0) {
      return results;
    }
  } catch (error) {
    preloadError = error;
    console.warn('预加载URL方法失败，尝试HTML方法:', error instanceof Error ? error.message : String(error));
  }

  try {
    return await searchDuckDuckGoHtml(query, limit);
  } catch (htmlError) {
    if (preloadError instanceof Error && htmlError instanceof Error) {
      throw new Error(`${htmlError.message} (preload path: ${preloadError.message})`, { cause: htmlError });
    }
    throw htmlError;
  }
  }

  /**
  * Extract preloaded d.js URL from DuckDuckGo search page and use it directly
  */
  async function searchDuckDuckGoPreloadUrl(query: string, maxResults = 10): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    let offset = 0;

    try {
      // Configure request options
      const requestOptions = buildAxiosRequestOptions({ engine: 'duckduckgo',
        trustedStaticHost: true,
        // 上界 10s：preload 与 HTML 两条路径各一次请求，避免单引擎累加超时吃光搜索总预算
        timeout: 10000,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Connection": "keep-alive",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          "sec-ch-ua": CHROME_133_SEC_CH_UA,
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": "\"Windows\"",
          "upgrade-insecure-requests": "1",
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
          "sec-fetch-user": "?1",
          "sec-fetch-dest": "document",
          "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7"
        }
      });

      const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=h_&ia=web`;
      const response = await axios.get(searchUrl, requestOptions);

      // 上游反爬升级：DDG 对非浏览器请求返回 202 挑战页（页面无 d.js preload URL）——
      // 显式报错而非静默 0 结果，让 partialFailures 暴露真实原因
      if (response.status === 202) {
        throw new Error('DuckDuckGo returned a challenge page (HTTP 202) — upstream anti-bot; retry later or use another engine');
      }

      let basePreloadUrl = '';

      // Method 1: Use cheerio to find preload links
      const $ = cheerio.load(response.data);
      $('link[rel="preload"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && isTrustedDuckDuckGoPreloadUrl(href)) {
          basePreloadUrl = href;
          return false; // 停止循环
        }
      });

      // Method 2: If preload link not found, try to get from script tag
      if (!basePreloadUrl) {
        $('#deep_preload_script').each((_, el) => {
          const src = $(el).attr('src');
          if (src && isTrustedDuckDuckGoPreloadUrl(src)) {
            basePreloadUrl = src;
            return false;
          }
        });
      }

      // Method 3: Use regex to extract from entire HTML
      if (!basePreloadUrl) {
        const urlMatch = response.data.match(/https:\/\/links\.duckduckgo\.com\/d\.js\?[^"']+/i);
        if (urlMatch && isTrustedDuckDuckGoPreloadUrl(urlMatch[0])) {
          basePreloadUrl = urlMatch[0];
        }
      }

      if (!basePreloadUrl) {
        console.warn('无法找到预加载的d.js URL');
        return [];
      }

      // Create URL object to easily modify parameters
      const preloadUrlObj = new URL(basePreloadUrl);

      // Loop to get results from all pages until maxResults is satisfied or no more results
      let hasMoreResults = true;

      const scriptRequestHeaders = {
        "User-Agent": BROWSER_USER_AGENT,
        "Connection": "keep-alive",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "sec-ch-ua": CHROME_133_SEC_CH_UA,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-site": "same-site",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-dest": "script",
        "referer": "https://duckduckgo.com/",
        "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7"
      };

      while (results.length < maxResults && hasMoreResults) {
        // Update s parameter (offset)
        preloadUrlObj.searchParams.set('s', offset.toString());

        // Get current page results
        const currentPageUrl = preloadUrlObj.toString();

        // Request search results using current page URL
        let dataResponse = await axios.get(currentPageUrl, {
          ...requestOptions,
          headers: scriptRequestHeaders
        });

        let rawScript = String(dataResponse.data || '');

        // 若 links.duckduckgo.com/d.js 返回 HTTP 202 且携带 isJsaChallenge (window.execDeep)，
        // 自动求解 HTML5 + 算术挑战并重放带 jsa_hash & jsa 的验证 URL
        if (dataResponse.status === 202 || rawScript.includes('isJsaChallenge')) {
          const solvedUrl = solveDuckDuckGoJsaChallenge(rawScript);
          if (solvedUrl) {
            dataResponse = await axios.get(solvedUrl, {
              ...requestOptions,
              headers: scriptRequestHeaders
            });
            rawScript = String(dataResponse.data || '');
            // 同步更新 dp 令牌以便后续分页复用已验证会话
            const solvedUrlObj = new URL(solvedUrl);
            const newDp = solvedUrlObj.searchParams.get('dp');
            if (newDp) {
              preloadUrlObj.searchParams.set('dp', newDp);
            }
          } else if (rawScript.includes('isJsaChallenge')) {
            // 静态解析失败（上游改了挑战脚本形状）→ 显式报错，不要静默返回 0 结果。
            // 文案匹配既有豁免模式 "DuckDuckGo returned a challenge page"，且按反爬类不可重试处理
            throw new Error('DuckDuckGo returned a challenge page (jsa challenge could not be solved statically)');
          }
        }

        if (rawScript.includes('anomalyDetectionBlock')) {
          throw new Error('DuckDuckGo d.js returned anomalyDetectionBlock (HTTP 202) — exit IP rate-limited');
        }

        // Extract JSON data from JSONP response
        const pageResults = parseDuckDuckGoJsonpPayload(rawScript);

        // If no results, means no more data
        if (pageResults.length === 0) {
          hasMoreResults = false;
          break;
        }

        // Calculate next page offset (current offset + current page results)
        let validResultsInCurrentPage = 0;

        // Process search results
        for (const result of pageResults) {
          validResultsInCurrentPage++;
          // If results already meet requirements, don't add more
          if (results.length >= maxResults) {
            break;
          }
          results.push(result);
        }

        // Update offset, prepare to request next page
        offset += validResultsInCurrentPage;
      }

      return results.slice(0, maxResults);
    } catch (error) {
      // 不要静默吞成"0 结果"：re-throw 让主入口 fallback 到 HTML 路径，
      // 若 HTML 也失败，真实原因（网络/限流/解析）能通过 partialFailures 暴露出来
      console.error('DuckDuckGo预加载URL搜索失败:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function searchDuckDuckGoHtml(query: string, maxResults = 10): Promise<SearchResult[]> {
  const requestUrl = 'https://html.duckduckgo.com/html/';

    // Configure request options
    const requestOptions = buildAxiosRequestOptions({ engine: 'duckduckgo',
    trustedStaticHost: true,
    timeout: 10000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_USER_AGENT,
      'Accept': '*/*',
      'Connection': 'keep-alive'
    },
  });

  try {
    const seenUrls = new Set<string>();
    const results: SearchResult[] = [];
    let offset = 0;
    let pageCount = 0;

    let response = await axios.post(
      requestUrl,
      new URLSearchParams({ q: query }).toString(),
      requestOptions
    );

    if (response.status === 202) {
      throw new Error('DuckDuckGo returned a challenge page (HTTP 202) — upstream anti-bot; retry later or use another engine');
    }

    let parsedPage = parseDuckDuckGoHtmlResults(String(response.data || ''), maxResults, seenUrls);
    results.push(...parsedPage.results);

    while (results.length < maxResults && parsedPage.rawCount > 0 && pageCount < 10) {
      offset += parsedPage.rawCount;
      pageCount += 1;

      // 记录本页 URL 集合，用于检测服务端重复返回导致的无进展死循环
      const beforeDedup = results.length;

      response = await axios.post(
        requestUrl,
        new URLSearchParams({
          q: query,
          s: offset.toString(),
          dc: offset.toString(),
          v: 'l',
          o: 'json',
          api: 'd.js'
        }).toString(),
        requestOptions
      );

      parsedPage = parseDuckDuckGoHtmlResults(String(response.data || ''), maxResults, seenUrls);
      results.push(...parsedPage.results);

      // 安全阀：本页没有新增任何去重后的结果，说明分页无进展，终止循环避免死循环
      if (results.length === beforeDedup) {
        console.warn('⚠️ DuckDuckGo pagination made no progress, stopping to avoid infinite loop');
        break;
      }
    }

    return results.slice(0, maxResults);
  } catch (error) {
    console.error('DuckDuckGo HTML search failed:', error instanceof Error ? error.message : String(error));
    // 向上抛错，由 searchService 的重试 + partialFailures 机制接管
    throw error;
  }
}
