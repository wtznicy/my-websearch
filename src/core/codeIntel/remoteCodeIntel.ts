import { AppError } from '../errors.js';
import { analyzeWithTreeSitter, type CodeSymbolCallSite } from './treeSitter.js';
import { inferTypeInfo } from './typeInference.js';
import { fileAnalysisCache, fileContentCache, hashContent, symbolResultCache } from './codeIntelCache.js';
import { getBoolean, getNumber } from '../../config/env.js';
import {
    CodeSymbolDefinition,
    CodeSymbolInput,
    CodeSymbolKind,
    CodeSymbolReference,
    CodeSymbolResult,
    TsconfigPathAlias
} from './types.js';
import {
    detectCodeLanguage,
    escapeRegExp,
    extractCodeDefinitions,
    isKindCompatible
} from './codeSymbolParser.js';
import {
    fetchRawFile,
    parseGitHubRepoSpec,
    searchGitHubCode
} from './githubSearch.js';
import {
    findReExportBinding,
    findReExportTargets,
    loadTsconfigAliases
} from './tsconfigAliases.js';

// Re-exports for backward compatibility
export * from './types.js';
export * from './codeSymbolParser.js';
export * from './githubSearch.js';
export * from './tsconfigAliases.js';

export async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    task: (item: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await task(items[index]!);
        }
    });
    await Promise.all(workers);
    return results;
}

export async function analyzeFileContent(
    content: string,
    filePath: string,
    symbol: string,
    kind?: CodeSymbolKind
): Promise<{ found: CodeSymbolDefinition[]; callSites: CodeSymbolCallSite[]; binding: CodeSymbolDefinition | null }> {
    const language = detectCodeLanguage(filePath);
    const cacheKey = `${hashContent(content)}|${filePath}|${symbol}|${kind ?? ''}`;
    const cached = fileAnalysisCache.get(cacheKey);
    if (cached) return cached;

    const analysis = await analyzeWithTreeSitter(content, filePath, language, symbol, kind);
    let found = analysis?.definitions.length ? analysis.definitions : extractCodeDefinitions(content, filePath, symbol, kind);
    if (found.length > 0) {
        const typeInfo = inferTypeInfo(content, filePath, symbol);
        if (typeInfo) found = found.map((definition) => ({ ...definition, typeInfo }));
    }
    const result = {
        found,
        callSites: analysis?.callSites ?? [],
        binding: findReExportBinding(content, filePath, symbol)
    };
    fileAnalysisCache.set(cacheKey, result);
    return result;
}

export async function findCodeSymbol(input: CodeSymbolInput): Promise<CodeSymbolResult> {
    const parsed = parseGitHubRepoSpec(input.repo);
    if (!parsed) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: `Invalid GitHub repository: ${input.repo}. Use owner/repo or a github.com URL.`
        });
    }

    const symbol = input.symbol.trim();
    if (!symbol || /[^\w$.-]/.test(symbol)) {
        throw new AppError({
            code: 'invalid_arguments',
            retryable: false,
            message: 'symbol must be a single identifier (letters, digits, _, $, ., -).'
        });
    }

    const maxResults = Math.min(Math.max(input.maxResults ?? 5, 1), 10);
    const resultCacheKey = `${parsed.owner}/${parsed.repo}@${input.ref ?? 'default'}|${symbol}|${input.kind ?? ''}|${maxResults}`;
    const cachedResult = symbolResultCache.get(resultCacheKey);
    if (cachedResult) {
        return { ...cachedResult, cached: true };
    }

    const budgetMs = getNumber('CODE_SYMBOL_BUDGET_MS', 8000, { min: 3000, max: 30000, integer: true });
    const deadline = Date.now() + budgetMs;
    let partial = false;
    const debug = getBoolean('CODE_SYMBOL_DEBUG', false);
    const debugStarted = Date.now();
    const debugLog = (stage: string): void => {
        if (debug) console.error(`[codeSymbol] ${stage} +${Date.now() - debugStarted}ms`);
    };
    debugLog('start');
    const paths = await searchGitHubCode(parsed.owner, parsed.repo, symbol, maxResults, input.signal);
    debugLog(`search paths=${paths.length}`);
    const refsToTry = input.ref ? [input.ref] : ['main', 'master'];
    let aliases: TsconfigPathAlias[] = [];
    let aliasesPromise: Promise<TsconfigPathAlias[]> | null = null;
    const ensureAliases = async (): Promise<TsconfigPathAlias[]> => {
        if (!aliasesPromise) {
            aliasesPromise = loadTsconfigAliases(parsed.owner, parsed.repo, refsToTry, input.signal);
        }
        aliases = await aliasesPromise;
        return aliases;
    };
    const warnings: string[] = [];
    const definitions: CodeSymbolDefinition[] = [];
    const references: CodeSymbolReference[] = [];
    const callSites: CodeSymbolCallSite[] = [];
    let filesScanned = 0;

    type WorkItem = { path: string; via?: string; depth: number };
    const directQueue: WorkItem[] = paths.slice(0, 12).map((filePath) => ({ path: filePath, depth: 0 }));
    const reexportQueue: WorkItem[] = [];
    const visited = new Set<string>();
    const fetchWithRefs = async (filePath: string): Promise<string | null> => {
        const contentKey = `${parsed.owner}/${parsed.repo}/${refsToTry[0] ?? 'HEAD'}/${filePath}`;
        const cached = fileContentCache.get(contentKey);
        if (cached !== null) return cached;
        for (const ref of refsToTry) {
            const content = await fetchRawFile(parsed.owner, parsed.repo, ref, filePath, input.signal);
            if (content !== null) {
                fileContentCache.set(contentKey, content);
                return content;
            }
        }
        return null;
    };
    const directContents = new Map<string, string | null>();
    await mapWithConcurrency(directQueue, 4, async (item) => {
        directContents.set(item.path, await fetchWithRefs(item.path));
    });
    debugLog('direct fetch complete');

    const precomputed = new Map<string, Awaited<ReturnType<typeof analyzeFileContent>>>();
    const precomputable = directQueue.filter((item) => (directContents.get(item.path) ?? null) !== null);
    await mapWithConcurrency(precomputable, 3, async (item) => {
        const content = directContents.get(item.path);
        if (content) {
            precomputed.set(item.path, await analyzeFileContent(content, item.path, symbol, input.kind));
        }
    });
    debugLog('direct analysis complete');

    while ((directQueue.length > 0 || reexportQueue.length > 0) && filesScanned < 18) {
        // Direct files were already fetched/analyzed in parallel. Process those
        // cached analyses even after the soft deadline so a budget expiry returns
        // partial definitions instead of an empty result.
        const nextItem = directQueue[0] ?? reexportQueue[0]!;
        if (Date.now() > deadline && !precomputed.has(nextItem.path)) {
            partial = true;
            warnings.push(`Stopped at the ${budgetMs}ms codeSymbol budget; results are partial.`);
            break;
        }
        // Scan every direct code-search hit before spending budget on barrels.
        const item = directQueue.shift() ?? reexportQueue.shift()!;
        if (visited.has(item.path)) continue;
        visited.add(item.path);

        const content = directContents.has(item.path)
            ? directContents.get(item.path) ?? null
            : await fetchWithRefs(item.path);
        if (content === null) {
            warnings.push(`Could not fetch ${item.path}.`);
            continue;
        }
        filesScanned += 1;
        const analyzed = precomputed.get(item.path)
            ?? await analyzeFileContent(content, item.path, symbol, input.kind);
        const found = analyzed.found.map((definition) => item.via ? { ...definition, via: item.via } : definition);
        if (found.length > 0) {
            definitions.push(...found);
        } else if (analyzed.binding && isKindCompatible(analyzed.binding.kind, input.kind)) {
            definitions.push(item.via ? { ...analyzed.binding, via: item.via } : analyzed.binding);
        } else if (item.depth < 4) {
            let targets = findReExportTargets(content, item.path, symbol, aliases);
            if (targets.length === 0 && /from\s*['"][^./][^'"]*['"]/.test(content)) {
                await ensureAliases();
                targets = findReExportTargets(content, item.path, symbol, aliases);
            }
            for (const target of targets.slice(0, 4)) {
                if (!visited.has(target)) {
                    reexportQueue.push({ path: target, via: item.path, depth: item.depth + 1 });
                }
            }
        }

        if (analyzed.callSites.length > 0) {
            callSites.push(...analyzed.callSites);
        }

        const lines = content.split(/\r?\n/);
        const mentionLines = lines
            .map((line, index) => ({ line, index: index + 1 }))
            .filter(({ line }) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(line))
            .map(({ index }) => index)
            .filter((lineNumber) => !found.some((definition) =>
                lineNumber >= definition.startLine && lineNumber <= definition.endLine));
        if (mentionLines.length > 0) {
            references.push({ path: item.path, lines: mentionLines.slice(0, 20) });
        }
    }

    if (definitions.length === 0) {
        warnings.push('No declaration matched. Try a different kind or pass the exact symbol name.');
    } else if (definitions.some((definition) => definition.via)) {
        warnings.push('Definition was resolved through a re-export; the `via` field records the entry file.');
    }
    if (reexportQueue.length > 0) {
        warnings.push(`Stopped after scanning ${filesScanned} files; ${reexportQueue.length} re-export targets remain unscanned.`);
    }
    if (!partial && Date.now() > deadline) {
        partial = true;
        warnings.push(`CodeSymbol exceeded its ${budgetMs}ms soft budget.`);
    }
    debugLog('scan complete');

    const result: CodeSymbolResult = {
        repo: `${parsed.owner}/${parsed.repo}`,
        symbol,
        ref: input.ref ?? (paths.length > 0 ? 'default branch' : 'unknown'),
        definitions: definitions.slice(0, maxResults),
        references,
        callSites: callSites.slice(0, 30),
        filesScanned,
        warnings,
        partial
    };
    if (!partial) {
        symbolResultCache.set(resultCacheKey, result);
    }
    return result;
}
