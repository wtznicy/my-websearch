import path from 'node:path';
import { CodeSymbolDefinition, TsconfigPathAlias } from './types.js';
import { detectCodeLanguage } from './codeSymbolParser.js';
import { fetchRawFile, fetchTsconfigPaths } from './githubSearch.js';

export function resolveCandidateExtensions(target: string): string[] {
    const withoutExtension = target.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx)$/i, '');
    const candidates = new Set<string>([target]);
    for (const extension of ['.ts', '.tsx', '.d.ts', '.js', '.jsx']) {
        candidates.add(`${withoutExtension}${extension}`);
        candidates.add(path.posix.join(withoutExtension, `index${extension}`));
    }
    return [...candidates];
}

export function resolveModuleCandidates(filePath: string, specifier: string): string[] {
    if (!specifier.startsWith('.')) return [];
    const base = path.posix.dirname(filePath);
    return resolveCandidateExtensions(path.posix.normalize(path.posix.join(base, specifier)));
}

export function parseTsconfigPathAliases(raw: string, configDir = ''): TsconfigPathAlias[] {
    try {
        const withoutComments = raw
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1')
            .replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(withoutComments) as {
            compilerOptions?: {
                baseUrl?: string;
                paths?: Record<string, string[]>;
            };
        };
        const baseUrl = path.posix.normalize(path.posix.join(
            configDir.replace(/^\.\//, ''),
            parsed.compilerOptions?.baseUrl?.replace(/^\.\//, '') || '.'
        ));
        return Object.entries(parsed.compilerOptions?.paths ?? {}).map(([pattern, targets]) => {
            const starIndex = pattern.indexOf('*');
            return {
                prefix: starIndex >= 0 ? pattern.slice(0, starIndex) : pattern,
                suffix: starIndex >= 0 ? pattern.slice(starIndex + 1) : '',
                targets: Array.isArray(targets) ? targets : [],
                baseUrl
            };
        });
    } catch {
        return [];
    }
}

/** Detect `import * as z ...; export { z }` / aliased imports as a symbol binding. */
export function findReExportBinding(
    content: string,
    filePath: string,
    symbol: string
): CodeSymbolDefinition | null {
    const imports = new Map<string, { kind: 'namespace' | 'const' }>();
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        const namespace = line.match(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"]/);
        if (namespace?.[1]) imports.set(namespace[1], { kind: 'namespace' });
        const named = line.match(/^\s*import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/);
        if (named?.[1]) {
            for (const item of named[1].split(',')) {
                const [imported, alias] = item.trim().split(/\s+as\s+/);
                const local = alias ?? imported;
                if (local) imports.set(local.trim(), { kind: 'const' });
            }
        }
    }

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const exported = line.match(/^\s*export\s*\{([^}]*)\}\s*;?\s*$/);
        if (!exported?.[1]) continue;
        const items = exported[1].split(',').map((item) => item.trim()).filter(Boolean);
        const matched = items.some((item) => {
            const [imported, alias] = item.split(/\s+as\s+/).map((part) => part.trim());
            return imported === symbol || alias === symbol;
        });
        if (!matched) continue;
        const kind = imports.get(symbol)?.kind === 'namespace' ? 'namespace' : 'const';
        return {
            path: filePath,
            language: detectCodeLanguage(filePath),
            kind,
            signature: line.trim(),
            startLine: index + 1,
            endLine: index + 1,
            code: line.trim(),
            truncated: false
        };
    }
    return null;
}

/** Resolve `export { X } from './module'` / `export * from './module'` targets. */
export function findReExportTargets(
    content: string,
    filePath: string,
    symbol: string,
    aliases: TsconfigPathAlias[] = []
): string[] {
    const targets: string[] = [];
    const namedTargets: string[] = [];
    const starTargets: string[] = [];
    const resolveSpecifier = (specifier: string): string[] => {
        if (specifier.startsWith('.')) {
            return resolveModuleCandidates(filePath, specifier);
        }
        for (const alias of aliases) {
            if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) continue;
            const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
            for (const target of alias.targets) {
                const resolved = target.replace('*', middle);
                const base = alias.baseUrl === '.' ? '' : alias.baseUrl;
                targets.push(...resolveCandidateExtensions(path.posix.normalize(path.posix.join(base, resolved))));
            }
        }
        return [];
    };

    const lines = content.split(/\r?\n/);
    const importedFrom = new Map<string, string>();
    let exportsSymbol = false;

    for (const line of lines) {
        // Track: import { X } from './mod' / import X from './mod' / import * as X from './mod'
        const importNamed = line.match(/^\s*import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);
        if (importNamed?.[1] && importNamed[2]) {
            const names = importNamed[1].split(',').map((item) => item.trim()).filter(Boolean);
            for (const item of names) {
                const [imported, local] = item.split(/\s+as\s+/).map((part) => part.trim());
                const effectiveLocal = local || imported;
                if (effectiveLocal) importedFrom.set(effectiveLocal, importNamed[2]);
            }
        }
        const importDefaultOrStar = line.match(/^\s*import\s*(?:type\s*)?(?:\*\s+as\s+([\w$]+)|([\w$]+))\s*from\s*['"]([^'"]+)['"]/);
        if (importDefaultOrStar?.[3]) {
            const local = importDefaultOrStar[1] || importDefaultOrStar[2];
            if (local) importedFrom.set(local, importDefaultOrStar[3]);
        }

        // Direct re-export: export { X } from './mod'
        const named = line.match(/^\s*export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);
        if (named?.[1] && named[2]) {
            const names = named[1].split(',').map((item) => item.trim()).filter(Boolean);
            const matches = names.some((item) => {
                const [imported, exported] = item.split(/\s+as\s+/).map((part) => part.trim());
                return imported === symbol || exported === symbol;
            });
            if (matches) namedTargets.push(...resolveSpecifier(named[2]));
            continue;
        }

        // Wildcard re-export: export * from './mod'
        const star = line.match(/^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/);
        if (star?.[1]) {
            starTargets.push(...resolveSpecifier(star[1]));
            continue;
        }

        // Multi-step re-export: export { X } (without from)
        const exportOnly = line.match(/^\s*export\s*(?:type\s*)?\{([^}]*)\}\s*(?:;|$)/);
        if (exportOnly?.[1]) {
            const names = exportOnly[1].split(',').map((item) => item.trim()).filter(Boolean);
            if (names.some((item) => {
                const [local, exported] = item.split(/\s+as\s+/).map((part) => part.trim());
                return local === symbol || exported === symbol;
            })) {
                exportsSymbol = true;
            }
        }
        const exportDefault = line.match(/^\s*export\s+default\s+([\w$]+)\s*(?:;|$)/);
        if (exportDefault?.[1] && exportDefault[1] === symbol) {
            exportsSymbol = true;
        }
    }

    if (exportsSymbol && importedFrom.has(symbol)) {
        const specifier = importedFrom.get(symbol)!;
        namedTargets.push(...resolveSpecifier(specifier));
    }

    targets.push(...namedTargets, ...starTargets);
    return [...new Set(targets)];
}

export function parseTsconfigExtends(raw: string): string[] {
    try {
        const withoutComments = raw
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1')
            .replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(withoutComments) as { extends?: string | string[] };
        if (typeof parsed.extends === 'string') return [parsed.extends];
        return Array.isArray(parsed.extends) ? parsed.extends.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

export async function loadTsconfigAliasesUncached(
    owner: string,
    repo: string,
    refsToTry: string[],
    signal?: AbortSignal
): Promise<TsconfigPathAlias[]> {
    const aliases: TsconfigPathAlias[] = [];
    const seen = new Set<string>();
    const addAliases = (parsed: TsconfigPathAlias[]): void => {
        for (const alias of parsed) {
            const key = `${alias.baseUrl}|${alias.prefix}|${alias.suffix}|${alias.targets.join(',')}`;
            if (!seen.has(key)) {
                seen.add(key);
                aliases.push(alias);
            }
        }
    };

    for (const ref of refsToTry) {
        const contentCache = new Map<string, string | null>();
        const aliasesCache = new Map<string, Promise<TsconfigPathAlias[]>>();
        const visiting = new Set<string>();
        const loadContent = async (configPath: string): Promise<string | null> => {
            if (contentCache.has(configPath)) return contentCache.get(configPath) ?? null;
            const content = await fetchRawFile(owner, repo, ref, configPath, signal);
            contentCache.set(configPath, content);
            return content;
        };

        const loadConfig = async (configPath: string, depth = 0): Promise<TsconfigPathAlias[]> => {
            if (aliasesCache.has(configPath)) return aliasesCache.get(configPath)!;
            if (visiting.has(configPath)) return [];
            visiting.add(configPath);
            const promise = (async () => {
                const content = await loadContent(configPath);
                if (!content) return [];
                const inherited: TsconfigPathAlias[] = [];
                if (depth < 5) {
                    for (const specifier of parseTsconfigExtends(content)) {
                        if (!specifier.startsWith('.')) continue;
                        const baseDir = path.posix.dirname(configPath);
                        const target = path.posix.normalize(path.posix.join(baseDir, specifier));
                        for (const candidate of [target, `${target}.json`]) {
                            if (candidate.endsWith('.json')) {
                                inherited.push(...await loadConfig(candidate, depth + 1));
                                break;
                            }
                        }
                    }
                }
                const configDir = path.posix.dirname(configPath);
                const own = parseTsconfigPathAliases(content, configDir === '.' ? '' : configDir);
                return [...inherited, ...own];
            })().finally(() => {
                visiting.delete(configPath);
            });
            aliasesCache.set(configPath, promise);
            return promise;
        };

        const rootContent = await loadContent('tsconfig.json');
        if (rootContent) addAliases(await loadConfig('tsconfig.json'));
        if (await loadContent('tsconfig.base.json')) addAliases(await loadConfig('tsconfig.base.json'));

        const shouldDiscoverPackages = !rootContent || rootContent.includes('"references"') || aliases.length === 0;
        let configPaths: string[] = [];
        if (shouldDiscoverPackages) {
            configPaths = await fetchTsconfigPaths(owner, repo, ref, signal);
            const packageConfigs = configPaths
                .filter((configPath) => configPath !== 'tsconfig.json' && configPath !== 'tsconfig.base.json')
                .slice(0, 8);
            const loaded = await Promise.all(packageConfigs.map((configPath) => loadConfig(configPath)));
            for (const parsed of loaded) addAliases(parsed);
        }
        // If main/master was requested but the branch does not exist, continue
        // to the next ref. Returning immediately here made master-only repos
        // silently lose all tsconfig aliases.
        if (rootContent !== null || aliases.length > 0 || configPaths.length > 0) {
            return aliases;
        }
    }
    return aliases;
}

export const tsconfigAliasCache = new Map<string, Promise<TsconfigPathAlias[]>>();

export function loadTsconfigAliases(
    owner: string,
    repo: string,
    refsToTry: string[],
    signal?: AbortSignal
): Promise<TsconfigPathAlias[]> {
    const cacheKey = `${owner}/${repo}@${refsToTry.join(',')}`;
    const cached = tsconfigAliasCache.get(cacheKey);
    if (cached) return cached;
    const promise = loadTsconfigAliasesUncached(owner, repo, refsToTry, signal);
    tsconfigAliasCache.set(cacheKey, promise);
    return promise;
}
