import { describe, expect, it } from 'vitest';
import { inferTypeInfo } from '../../core/codeIntel/typeInference.js';

describe('semantic type inference', () => {
    it('infers a function return type and parameters with the TypeScript checker', () => {
        const source = [
            'export function greet(name: string) {',
            '    const prefix = "hello ";',
            '    return prefix + name;',
            '}'
        ].join('\n');
        const info = inferTypeInfo(source, 'src/greet.ts', 'greet');
        expect(info).not.toBeNull();
        expect(info?.returnType).toBe('string');
        expect(info?.parameters?.[0]).toContain('name: string');
    });

    it('returns type info for variables and interfaces', () => {
        const source = [
            'export const answer = 42;',
            'export interface User { name: string; age: number }'
        ].join('\n');
        expect(inferTypeInfo(source, 'src/types.ts', 'answer')?.type).toBe('42');
        expect(inferTypeInfo(source, 'src/types.ts', 'User')?.type).toContain('User');
    });

    it('extracts return type and parameters from arrow-function variables', () => {
        const source = 'export const add = (left: number, right: number) => left + right;';
        const info = inferTypeInfo(source, 'src/math.ts', 'add');
        expect(info?.returnType).toBe('number');
        expect(info?.parameters?.join(', ')).toContain('left: number');
    });

    it('returns null for unsupported languages', () => {
        expect(inferTypeInfo('plain text', 'src/notes.txt', 'foo')).toBeNull();
    });

    it('extracts Python annotations', () => {
        const source = [
            '@router.get("/items/{item_id}")',
            'def read_item(item_id: int, q: str = "x") -> bool:',
            '    return True'
        ].join('\n');
        const info = inferTypeInfo(source, 'app/routes.py', 'read_item');
        expect(info?.returnType).toBe('bool');
        expect(info?.parameters).toEqual(['item_id: int', 'q: str']);
    });

    it('extracts Go signatures', () => {
        const source = 'func Add(left int, right int) (int, error) {\n    return left + right, nil\n}';
        const info = inferTypeInfo(source, 'math.go', 'Add');
        expect(info?.parameters).toEqual(['left int', 'right int']);
        expect(info?.returnType).toContain('int, error');
    });

    it('extracts Rust signatures', () => {
        const source = 'pub fn add(left: i32, right: i32) -> i32 {\n    left + right\n}';
        const info = inferTypeInfo(source, 'src/math.rs', 'add');
        expect(info?.parameters).toEqual(['left: i32', 'right: i32']);
        expect(info?.returnType).toBe('i32');
    });
});
