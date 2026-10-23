import { describe, expect, it } from 'vitest';
import {
    findAmbiguousLibraryCandidates,
    pickBestLibrary,
    evaluateLibraryMatchConfidence
} from '../../core/context7/context7Service.js';
import type { Context7Library } from '../../engines/context7/context7.js';

const lib = (id: string, title: string, extra: Partial<Context7Library> = {}): Context7Library => ({
    id,
    title,
    description: `${title} docs`,
    versions: [],
    ...extra
});

/**
 * 回归：裸库名 "tailwindcss" 曾解析到 /catppuccin/tailwindcss（第三方配色主题），
 * 并标 high confidence。现在裸库名优先命中官方映射，歧义命中最多 medium。
 */
describe('Context7 library resolution', () => {
    const candidates = [
        lib('/catppuccin/tailwindcss', 'TailwindCSS', { trustScore: 9, benchmarkScore: 9, totalSnippets: 400 }),
        lib('/tailwindlabs/tailwindcss', 'Tailwind CSS', { trustScore: 7, benchmarkScore: 8, totalSnippets: 300 })
    ];

    it('picks the official repository for a bare library name', () => {
        expect(pickBestLibrary(candidates, 'tailwindcss')?.id).toBe('/tailwindlabs/tailwindcss');
    });

    it('keeps full Context7 IDs authoritative', () => {
        expect(pickBestLibrary(candidates, '/catppuccin/tailwindcss')?.id).toBe('/catppuccin/tailwindcss');
    });

    it('detects same-slug candidates from different owners', () => {
        expect(findAmbiguousLibraryCandidates(candidates, 'tailwindcss')).toHaveLength(2);
        expect(findAmbiguousLibraryCandidates(candidates, '/catppuccin/tailwindcss')).toHaveLength(0);
    });

    it('never labels a third-party same-slug package as high confidence', () => {
        expect(evaluateLibraryMatchConfidence(candidates[0]!, 'tailwindcss', candidates)).toBe('medium');
        expect(evaluateLibraryMatchConfidence(candidates[1]!, 'tailwindcss', candidates)).toBe('high');
    });
});
