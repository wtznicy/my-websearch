import { CodeSymbolCallSite } from './treeSitter.js';
import { CodeTypeInfo } from './typeInference.js';

export type CodeSymbolKind = 'class' | 'function' | 'interface' | 'type' | 'method' | 'const' | 'enum' | 'struct' | 'trait' | 'namespace';

export interface CodeSymbolInput {
    repo: string;
    symbol: string;
    kind?: CodeSymbolKind;
    ref?: string;
    maxResults?: number;
    signal?: AbortSignal;
}

export interface CodeSymbolDefinition {
    path: string;
    language: string;
    kind: string;
    signature: string;
    startLine: number;
    endLine: number;
    code: string;
    /** Present when the symbol was found through an `export { ... } from` re-export. */
    via?: string;
    truncated?: boolean;
    /** Best-effort TypeScript/JavaScript semantic type info. */
    typeInfo?: CodeTypeInfo;
}

export interface CodeSymbolReference {
    path: string;
    lines: number[];
}

export interface CodeSymbolResult {
    repo: string;
    symbol: string;
    ref: string;
    definitions: CodeSymbolDefinition[];
    references: CodeSymbolReference[];
    callSites: CodeSymbolCallSite[];
    filesScanned: number;
    warnings: string[];
    cached?: boolean;
    partial?: boolean;
}

export interface TsconfigPathAlias {
    prefix: string;
    suffix: string;
    targets: string[];
    baseUrl: string;
}
