import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildCodeLookupPrompt, buildDeepResearchPrompt, registerPrompts } from '../../tools/prompts.js';

describe('MCP prompts', () => {
    it('builds a deep research prompt with multi-source instructions', () => {
        const prompt = buildDeepResearchPrompt('Next.js 15 breaking changes', 'deep');
        expect(prompt).toContain('Next.js 15 breaking changes');
        expect(prompt).toContain('search');
        expect(prompt).toContain('queryDocs');
        expect(prompt).toContain('fetchGithubContent');
        expect(prompt).toContain('evidence');
    });

    it('builds a compact quick-research prompt', () => {
        const prompt = buildDeepResearchPrompt('Rust async runtimes', 'quick');
        expect(prompt).toContain('2-3 searches');
    });

    it('builds a code lookup prompt with docs and release notes', () => {
        const prompt = buildCodeLookupPrompt('next.js', 'How do I use the App Router?');
        expect(prompt).toContain('next.js');
        expect(prompt).toContain('How do I use the App Router?');
        expect(prompt).toContain('queryDocs');
        expect(prompt).toContain('release notes');
    });

    it('registers both prompts on the MCP server', () => {
        const registered: string[] = [];
        const server = {
            registerPrompt: (name: string) => { registered.push(name); }
        } as unknown as McpServer;
        registerPrompts(server);
        expect(registered).toEqual(['deep-research', 'code-lookup']);
    });
});
