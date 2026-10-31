import { describe, expect, it } from 'vitest';
import {
    buildRawFileUrls,
    detectCodeLanguage,
    extractCodeDefinitions,
    findReExportBinding,
    findReExportTargets,
    isCodeFilePath,
    parseGitHubRepoSpec,
    parseTsconfigExtends,
    parseTsconfigPathAliases,
    rankCodePaths
} from '../../core/codeIntel/remoteCodeIntel.js';

describe('remote code intelligence', () => {
    it('parses GitHub repo specs', () => {
        expect(parseGitHubRepoSpec('fastapi/fastapi')).toEqual({ owner: 'fastapi', repo: 'fastapi' });
        expect(parseGitHubRepoSpec('https://github.com/fastapi/fastapi.git')).toEqual({ owner: 'fastapi', repo: 'fastapi' });
        expect(parseGitHubRepoSpec('git@github.com:fastapi/fastapi.git')).toEqual({ owner: 'fastapi', repo: 'fastapi' });
        expect(parseGitHubRepoSpec('not a repo')).toBeNull();
    });

    it('detects supported languages from file extensions', () => {
        expect(detectCodeLanguage('src/index.ts')).toBe('typescript');
        expect(detectCodeLanguage('app/main.py')).toBe('python');
        expect(detectCodeLanguage('cmd/main.go')).toBe('go');
        expect(detectCodeLanguage('src/lib.rs')).toBe('rust');
    });

    it('extracts TypeScript symbols with brace-scoped bodies', () => {
        const source = [
            'export interface Depends {',
            '    useCache?: boolean;',
            '}',
            '',
            'export class Depends {',
            '    constructor(options: DependsOptions = {}) {}',
            '}',
            '',
            'export function helper() {',
            '    return 1;',
            '}'
        ].join('\n');

        const definitions = extractCodeDefinitions(source, 'src/depends.ts', 'Depends');
        expect(definitions).toHaveLength(2);
        expect(definitions[0]?.kind).toBe('interface');
        expect(definitions[0]?.startLine).toBe(1);
        expect(definitions[1]?.kind).toBe('class');
        expect(definitions[1]?.code).toContain('constructor');
        expect(definitions[1]?.endLine).toBe(7);
    });

    it('extracts Python symbols by indentation', () => {
        const source = [
            'class Depends:',
            '    def __init__(self):',
            '        pass',
            '',
            '    def resolve(self):',
            '        return 1',
            '',
            'def Depends():',
            '    return 2'
        ].join('\n');

        const definitions = extractCodeDefinitions(source, 'fastapi/params.py', 'Depends');
        expect(definitions.map((definition) => definition.kind)).toEqual(['class', 'function']);
        expect(definitions[0]?.endLine).toBe(6);
    });

    it('extracts Go and Rust declarations', () => {
        const go = 'func (r *Repo) Depends() {}\ntype Depends struct {}\n';
        expect(extractCodeDefinitions(go, 'repo.go', 'Depends').map((definition) => definition.kind))
            .toEqual(['function', 'type']);

        const rust = 'pub async fn Depends() {}\npub struct Depends;\n';
        expect(extractCodeDefinitions(rust, 'lib.rs', 'Depends').map((definition) => definition.kind))
            .toEqual(['function', 'struct']);
    });

    it('filters by kind and returns no match for unknown symbols', () => {
        const source = 'export class Depends {}\nexport function Depends() {}\n';
        expect(extractCodeDefinitions(source, 'x.ts', 'Depends', 'class')).toHaveLength(1);
        expect(extractCodeDefinitions(source, 'x.ts', 'Missing')).toEqual([]);
    });

    it('keeps multi-line signatures and parameter types', () => {
        const source = [
            'export async function findCodeSymbol(',
            '    input: CodeSymbolInput,',
            '    options?: RequestOptions',
            '): Promise<CodeSymbolResult> {',
            '    return null as unknown as CodeSymbolResult;',
            '}'
        ].join('\n');
        const definition = extractCodeDefinitions(source, 'src/remote.ts', 'findCodeSymbol')[0];
        expect(definition?.signature).toContain('input: CodeSymbolInput');
        expect(definition?.signature).toContain('options?: RequestOptions');
        expect(definition?.signature).toContain('Promise<CodeSymbolResult>');
        expect(definition?.endLine).toBe(6);
    });

    it('includes Python decorators in the signature and code block', () => {
        const source = [
            '@router.get("/items/{item_id}", response_model=ItemResponse)',
            '@require_auth(Role.ADMIN)',
            'def read_item(item_id: int):',
            '    return item_id'
        ].join('\n');
        const definition = extractCodeDefinitions(source, 'app/routes.py', 'read_item')[0];
        expect(definition?.startLine).toBe(1);
        expect(definition?.signature).toContain('@router.get');
        expect(definition?.signature).toContain('@require_auth');
        expect(definition?.code).toContain('@router.get');
    });

    it('ignores braces in strings, comments and regex literals', () => {
        const source = [
            'function Depends() {',
            '    const text = "}";',
            '    // }',
            '    const re = /{/;',
            '    /* } */',
            '    return 1;',
            '}'
        ].join('\n');
        const definition = extractCodeDefinitions(source, 'src/braces.ts', 'Depends')[0];
        expect(definition?.endLine).toBe(7);
    });

    it('marks truncated code blocks explicitly', () => {
        const body = Array.from({ length: 70 }, (_, index) => `    const value${index} = ${index};`).join('\n');
        const source = `function Depends() {\n${body}\n}`;
        const definition = extractCodeDefinitions(source, 'src/long.ts', 'Depends')[0];
        expect(definition?.truncated).toBe(true);
        expect(definition?.code).toContain('[truncated');
    });

    it('resolves re-export targets and builds raw/CDN URLs', () => {
        const targets = findReExportTargets("export { Depends } from './params.js';", 'src/index.ts', 'Depends');
        expect(targets).toContain('src/params.ts');
        expect(targets).toContain('src/params/index.ts');

        const urls = buildRawFileUrls('fastapi', 'fastapi', 'master', 'fastapi/params.py');
        expect(urls[0]).toContain('raw.githubusercontent.com/fastapi/fastapi/master');
        expect(urls[1]).toContain('cdn.jsdelivr.net/gh/fastapi/fastapi@master');
    });

    it('resolves tsconfig path aliases in re-exports', () => {
        const aliases = parseTsconfigPathAliases(JSON.stringify({
            compilerOptions: {
                baseUrl: '.',
                paths: { '@/*': ['src/*'] }
            }
        }));
        const targets = findReExportTargets("export { Depends } from '@/params.js';", 'src/index.ts', 'Depends', aliases);
        expect(targets).toContain('src/params.ts');
    });

    it('detects namespace import/export bindings (zod-style z)', () => {
        const index = [
            'import * as z from "./v4/classic/external.js";',
            'export * from "./v4/classic/external.js";',
            'export { z, z as default };'
        ].join('\n');
        const binding = findReExportBinding(index, 'packages/zod/src/index.ts', 'z');
        expect(binding?.kind).toBe('namespace');
        expect(binding?.startLine).toBe(3);
        expect(binding?.signature).toContain('export { z, z as default }');
    });

    it('resolves package-level tsconfig aliases relative to the config directory', () => {
        const aliases = parseTsconfigPathAliases(JSON.stringify({
            compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }
        }), 'packages/api');
        const targets = findReExportTargets("export { Depends } from '@/params.js';", 'packages/api/index.ts', 'Depends', aliases);
        expect(targets).toContain('packages/api/src/params.ts');
    });

    it('parses local tsconfig extends chains', () => {
        expect(parseTsconfigExtends('{"extends": "../../tsconfig.base.json"}'))
            .toEqual(['../../tsconfig.base.json']);
        expect(parseTsconfigExtends('{"extends": ["./a.json", "./b.json"]}'))
            .toEqual(['./a.json', './b.json']);
        expect(parseTsconfigExtends('not json')).toEqual([]);
    });

    it('never treats Markdown prose as a function declaration', () => {
        const markdown = '- **Easier unions**. Use the `or` method to ZodType (the base class for all Zod types)';
        expect(extractCodeDefinitions(markdown, 'packages/docs/MIGRATION.md', 'ZodType')).toEqual([]);
        expect(isCodeFilePath('MIGRATION.md')).toBe(false);
        expect(isCodeFilePath('src/index.ts')).toBe(true);
    });

    it('ranks src/index code above docs, tests and generated files', () => {
        const ranked = rankCodePaths([
            'packages/docs/snippets/how-z-compile-works.mdx',
            'scripts/compile-fuzz.ts',
            'packages/treeshake/zod-full.ts',
            'packages/zod/src/index.ts',
            'packages/zod/dist/index.js'
        ]);
        expect(ranked[0]).toBe('packages/zod/src/index.ts');
        expect(ranked).not.toContain('packages/docs/snippets/how-z-compile-works.mdx');
        expect(ranked).not.toContain('packages/zod/dist/index.js');
    });
});
