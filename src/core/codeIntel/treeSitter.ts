import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import { isKindCompatible, type CodeSymbolDefinition, type CodeSymbolKind } from './remoteCodeIntel.js';
import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';

const GRAMMAR_VERSION = '0.3.1';
const GRAMMAR_BASE = `https://cdn.jsdelivr.net/npm/@vscode/tree-sitter-wasm@${GRAMMAR_VERSION}/wasm`;
const GRAMMAR_FILES: Record<string, string> = {
    typescript: 'tree-sitter-typescript.wasm',
    tsx: 'tree-sitter-tsx.wasm',
    javascript: 'tree-sitter-javascript.wasm',
    python: 'tree-sitter-python.wasm',
    go: 'tree-sitter-go.wasm',
    rust: 'tree-sitter-rust.wasm',
    java: 'tree-sitter-java.wasm',
    csharp: 'tree-sitter-c-sharp.wasm'
};

const KIND_BY_NODE: Record<string, string> = {
    class_declaration: 'class',
    class_definition: 'class',
    class_specifier: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    function_declaration: 'function',
    function_definition: 'function',
    function_item: 'function',
    method_definition: 'method',
    method_declaration: 'method',
    lexical_declaration: 'const',
    variable_declarator: 'const',
    enum_declaration: 'enum',
    enum_item: 'enum',
    struct_item: 'struct',
    struct_specifier: 'struct',
    trait_item: 'trait'
};

let parserInit: Promise<void> | null = null;
const languageCache = new Map<string, Language>();
const grammarPromises = new Map<string, Promise<string | null>>();

function runtimeWasmPath(): string {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('web-tree-sitter');
    return path.join(path.dirname(entry), 'web-tree-sitter.wasm');
}

function grammarCacheDir(): string {
    const dataDir = process.env.MY_WEBSEARCH_DATA_DIR?.trim() || path.join(os.homedir(), '.my-websearch');
    return path.join(dataDir, 'grammars');
}

async function downloadGrammar(fileName: string): Promise<string | null> {
    const cacheDir = grammarCacheDir();
    const target = path.join(cacheDir, fileName);
    try {
        if (fs.existsSync(target) && fs.statSync(target).size > 1000) {
            return target;
        }
    } catch {
        // continue to download
    }

    try {
        fs.mkdirSync(cacheDir, { recursive: true });
        const response = await requestDirectFirst(
            'GET',
            `${GRAMMAR_BASE}/${fileName}`,
            (forceDirect) => buildAxiosRequestOptions({
                headers: { 'User-Agent': DEFAULT_DESKTOP_UA },
                timeout: 4000,
                responseType: 'arraybuffer',
                forceDirect
            }),
            'Tree-sitter grammar'
        );
        if (response.status !== 200 || !response.data) {
            return null;
        }
        const bytes = Buffer.isBuffer(response.data)
            ? response.data
            : Buffer.from(response.data as ArrayBuffer);
        if (bytes.byteLength < 1000) {
            return null;
        }
        fs.writeFileSync(target, bytes);
        return target;
    } catch {
        return null;
    }
}

function ensureGrammar(fileName: string): Promise<string | null> {
    const existing = grammarPromises.get(fileName);
    if (existing) return existing;
    const promise = downloadGrammar(fileName);
    grammarPromises.set(fileName, promise);
    return promise;
}

async function getLanguage(language: string, filePath: string): Promise<Language | null> {
    const grammarKey = filePath.toLowerCase().endsWith('.tsx') || filePath.toLowerCase().endsWith('.jsx')
        ? 'tsx'
        : language;
    const fileName = GRAMMAR_FILES[grammarKey];
    if (!fileName) return null;

    const cached = languageCache.get(grammarKey);
    if (cached) return cached;

    const grammarPath = path.join(grammarCacheDir(), fileName);
    let available = false;
    try {
        available = fs.existsSync(grammarPath) && fs.statSync(grammarPath).size > 1000;
    } catch {
        available = false;
    }

    if (!available) {
        const download = ensureGrammar(fileName);
        if (process.env.CODE_SYMBOL_TREE_SITTER_WAIT === '1') {
            await download;
            try {
                available = fs.existsSync(grammarPath) && fs.statSync(grammarPath).size > 1000;
            } catch {
                available = false;
            }
        } else {
            // Never block the MCP tool on a cold grammar download. The scanner
            // answers this request; the next call can use the cached grammar.
            void download;
            return null;
        }
    }

    if (!available) return null;
    try {
        const loaded = await Language.load(fs.readFileSync(grammarPath));
        languageCache.set(grammarKey, loaded);
        return loaded;
    } catch {
        return null;
    }
}

async function getParser(language: string, filePath: string): Promise<Parser | null> {
    if (process.env.CODE_SYMBOL_TREE_SITTER === '0') return null;
    try {
        if (!parserInit) {
            parserInit = Parser.init({ locateFile: () => runtimeWasmPath() });
        }
        await parserInit;
        const lang = await getLanguage(language, filePath);
        if (!lang) return null;
        const parser = new Parser();
        parser.setLanguage(lang);
        return parser;
    } catch {
        return null;
    }
}

function truncateCode(code: string, language: string): { code: string; truncated: boolean } {
    const lines = code.split(/\r?\n/);
    const truncatedByLines = lines.length > 60;
    let output = lines.slice(0, 60).join('\n');
    const truncatedByChars = output.length > 8000;
    if (truncatedByChars) output = output.slice(0, 8000);
    if (truncatedByLines || truncatedByChars) {
        const comment = language === 'python' ? '#' : '//';
        output += `\n${comment} ... [truncated: showing ${Math.min(lines.length, 60)} of ${lines.length} lines]`;
    }
    return { code: output, truncated: truncatedByLines || truncatedByChars };
}

function signatureFromNode(node: SyntaxNode, startNode: SyntaxNode, content: string): string {
    const body = node.childForFieldName('body');
    const end = body?.startIndex ?? Math.min(node.endIndex, node.startIndex + 500);
    return content.slice(startNode.startIndex, end).replace(/\s+/g, ' ').trim().slice(0, 500);
}

export interface CodeSymbolCallSite {
    path: string;
    line: number;
    caller?: string;
    snippet: string;
}

const GENERIC_METHOD_NAMES = new Set([
    'get', 'set', 'init', 'parse', 'validate', 'run', 'call', 'apply', 'map', 'filter',
    'find', 'push', 'pop', 'update', 'render', 'load', 'save', 'open', 'close', 'read',
    'write', 'has', 'add', 'remove', 'delete', 'clear', 'reset', 'start', 'stop',
    'create', 'build', 'process', 'handle', 'execute', 'toString', 'valueOf'
]);

function enclosingCallerName(node: SyntaxNode): string | undefined {
    let current: SyntaxNode | null = node.parent;
    while (current) {
        if (
            current.type.includes('function')
            || current.type.includes('method')
            || current.type.includes('class')
        ) {
            const name = current.childForFieldName('name')?.text;
            if (name) return name;
        }
        current = current.parent;
    }
    return undefined;
}

export interface TreeSitterAnalysis {
    definitions: CodeSymbolDefinition[];
    callSites: CodeSymbolCallSite[];
}

/**
 * Parse once and extract both definitions and call sites.
 * Grammar downloads happen in the background; a cold call falls back to the
 * scanner immediately and a later call can use the cached grammar.
 */
export async function analyzeWithTreeSitter(
    content: string,
    filePath: string,
    language: string,
    symbol: string,
    kind?: CodeSymbolKind
): Promise<TreeSitterAnalysis | null> {
    const parser = await getParser(language, filePath);
    if (!parser) return null;

    try {
        const tree = parser.parse(content);
        if (!tree) return null;
        const definitions: CodeSymbolDefinition[] = [];
        const rawCalls: Array<{ node: SyntaxNode; called: string }> = [];
        const seenDefinitions = new Set<string>();
        let visited = 0;

        const walk = (node: SyntaxNode): void => {
            if (visited > 200_000) return;
            visited += 1;

            const nameNode = node.childForFieldName('name');
            const declaredKind = KIND_BY_NODE[node.type];
            if (nameNode?.text === symbol && declaredKind && isKindCompatible(declaredKind, kind)) {
                if (!seenDefinitions.has(`${node.startIndex}:${node.endIndex}`)) {
                    seenDefinitions.add(`${node.startIndex}:${node.endIndex}`);
                    const parent = node.parent;
                    const startNode = parent?.type === 'export_statement' || parent?.type === 'decorated_definition'
                        ? parent
                        : node;
                    const signature = signatureFromNode(node, startNode, content);
                    const rawCode = content.slice(startNode.startIndex, node.endIndex);
                    const truncated = truncateCode(rawCode, language);
                    definitions.push({
                        path: filePath,
                        language,
                        kind: declaredKind,
                        signature,
                        startLine: startNode.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        code: truncated.code,
                        truncated: truncated.truncated
                    });
                }
            }

            if (node.type === 'call_expression' || node.type === 'call' || node.type === 'method_invocation') {
                const fn = node.childForFieldName('function')
                    ?? node.childForFieldName('name');
                if (fn?.text) rawCalls.push({ node, called: fn.text });
            }

            for (const child of node.namedChildren) {
                walk(child);
            }
        };

        walk(tree.rootNode);
        tree.delete();

        const hasMethodDefinition = definitions.some((definition) => definition.kind === 'method');
        const genericMethod = GENERIC_METHOD_NAMES.has(symbol.toLowerCase());
        const callSites: CodeSymbolCallSite[] = [];
        const seenCallLines = new Set<number>();

        for (const { node, called } of rawCalls) {
            const bare = called === symbol;
            const member = called.endsWith(`.${symbol}`)
                || called.endsWith(`?.${symbol}`)
                || called.endsWith(`::${symbol}`);
            const thisMember = called === `this.${symbol}`;
            const allowMember = (kind === 'method' || hasMethodDefinition) && !genericMethod;
            if (!(bare || (member && allowMember) || (thisMember && hasMethodDefinition))) {
                continue;
            }
            if (seenCallLines.has(node.startPosition.row)) continue;
            seenCallLines.add(node.startPosition.row);
            callSites.push({
                path: filePath,
                line: node.startPosition.row + 1,
                caller: enclosingCallerName(node),
                snippet: content.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 240)).replace(/\s+/g, ' ').trim()
            });
            if (callSites.length >= 30) break;
        }

        definitions.sort((a, b) => {
            if (kind) {
                const aExact = a.kind === kind ? 1 : 0;
                const bExact = b.kind === kind ? 1 : 0;
                if (bExact !== aExact) return bExact - aExact;
            }
            return 0;
        });

        return { definitions, callSites };
    } catch {
        return null;
    } finally {
        parser.delete();
    }
}

/** Compatibility wrapper: one parse for definitions only. */
export async function extractDefinitionsWithTreeSitter(
    content: string,
    filePath: string,
    language: string,
    symbol: string,
    kind?: CodeSymbolKind
): Promise<CodeSymbolDefinition[] | null> {
    const analysis = await analyzeWithTreeSitter(content, filePath, language, symbol, kind);
    return analysis?.definitions.length ? analysis.definitions : null;
}

/** Compatibility wrapper: one parse for call sites only. */
export async function findCallSitesWithTreeSitter(
    content: string,
    filePath: string,
    language: string,
    symbol: string,
    kind?: CodeSymbolKind
): Promise<CodeSymbolCallSite[] | null> {
    const analysis = await analyzeWithTreeSitter(content, filePath, language, symbol, kind);
    return analysis?.callSites ?? null;
}
