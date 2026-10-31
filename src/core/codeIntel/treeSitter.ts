import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import type { CodeSymbolDefinition, CodeSymbolKind } from './remoteCodeIntel.js';
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
const languageCache = new Map<string, Promise<Language | null>>();

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
                timeout: 15000,
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

async function getLanguage(language: string, filePath: string): Promise<Language | null> {
    const grammarKey = filePath.toLowerCase().endsWith('.tsx') || filePath.toLowerCase().endsWith('.jsx')
        ? 'tsx'
        : language;
    const fileName = GRAMMAR_FILES[grammarKey];
    if (!fileName) return null;

    const cached = languageCache.get(grammarKey);
    if (cached) return cached;

    const promise = (async () => {
        const grammarPath = await downloadGrammar(fileName);
        if (!grammarPath) return null;
        try {
            return await Language.load(fs.readFileSync(grammarPath));
        } catch {
            return null;
        }
    })();
    languageCache.set(grammarKey, promise);
    return promise;
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

/** Find direct call sites for a symbol (syntactic; no receiver type inference). */
export async function findCallSitesWithTreeSitter(
    content: string,
    filePath: string,
    language: string,
    symbol: string
): Promise<CodeSymbolCallSite[] | null> {
    const parser = await getParser(language, filePath);
    if (!parser) return null;
    try {
        const tree = parser.parse(content);
        if (!tree) return null;
        const sites: CodeSymbolCallSite[] = [];
        const seen = new Set<number>();

        const walk = (node: SyntaxNode): void => {
            if (sites.length >= 30) return;
            const callNodeTypes = new Set(['call_expression', 'call', 'method_invocation']);
            if (callNodeTypes.has(node.type)) {
                const fn = node.childForFieldName('function')
                    ?? node.childForFieldName('name');
                const called = fn?.text ?? '';
                const matches = called === symbol
                    || called.endsWith(`.${symbol}`)
                    || called.endsWith(`?.${symbol}`)
                    || called.endsWith(`::${symbol}`);
                if (matches && !seen.has(node.startPosition.row)) {
                    seen.add(node.startPosition.row);
                    sites.push({
                        path: filePath,
                        line: node.startPosition.row + 1,
                        caller: enclosingCallerName(node),
                        snippet: content.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 240)).replace(/\s+/g, ' ').trim()
                    });
                }
            }
            for (const child of node.namedChildren) walk(child);
        };

        walk(tree.rootNode);
        tree.delete();
        return sites;
    } catch {
        return null;
    } finally {
        parser.delete();
    }
}

/**
 * Optional Tree-sitter backend. It downloads only the language grammar on first
 * use and caches it; if web-tree-sitter or the grammar is unavailable, callers
 * fall back to the dependency-free scanner.
 */
export async function extractDefinitionsWithTreeSitter(
    content: string,
    filePath: string,
    language: string,
    symbol: string,
    kind?: CodeSymbolKind
): Promise<CodeSymbolDefinition[] | null> {
    const parser = await getParser(language, filePath);
    if (!parser) return null;

    try {
        const tree = parser.parse(content);
        if (!tree) return null;
        const definitions: CodeSymbolDefinition[] = [];
        const seen = new Set<string>();
        let visited = 0;

        const walk = (node: SyntaxNode): void => {
            if (visited > 200_000) return;
            visited += 1;

            const nameNode = node.childForFieldName('name');
            const declaredKind = KIND_BY_NODE[node.type];
            if (nameNode?.text === symbol && declaredKind && (!kind || declaredKind === kind)) {
                if (!seen.has(`${node.startIndex}:${node.endIndex}`)) {
                    seen.add(`${node.startIndex}:${node.endIndex}`);
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

            for (const child of node.namedChildren) {
                walk(child);
            }
        };

        walk(tree.rootNode);
        tree.delete();
        return definitions.length > 0 ? definitions : null;
    } catch {
        return null;
    } finally {
        parser.delete();
    }
}
