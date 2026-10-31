import { describe, expect, it } from 'vitest';
import {
    detectCodeLanguage,
    extractCodeDefinitions,
    parseGitHubRepoSpec
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
});
