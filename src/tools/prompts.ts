import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function buildDeepResearchPrompt(topic: string, depth: 'quick' | 'deep' = 'deep'): string {
    const depthHint = depth === 'quick'
        ? 'Keep it to 2-3 searches and one pass of verification.'
        : 'Plan sub-questions, search multiple angles, open the most authoritative sources, and cross-check conflicting claims.';
    return [
        `Research the following topic: ${topic}`,
        '',
        depthHint,
        '',
        'Use this workflow:',
        '1. Break the topic into 2-5 concrete sub-questions.',
        '2. Call the `search` tool with multiple queries (and `engines` when useful) to cover different angles.',
        '3. For official library/framework docs, call `queryDocs` with an exact Context7 ID when possible.',
        '4. Open the top sources with `fetchWebContent`; for repositories use `fetchGithubContent` (README, source, releases).',
        '5. Compare sources, call out contradictions, and never invent a citation.',
        '',
        'Return: a concise answer, key claims, evidence (URL + quoted fragment), and any unresolved uncertainty.'
    ].join('\n');
}

export function buildCodeLookupPrompt(library: string, question: string): string {
    return [
        `Answer this code question about "${library}": ${question}`,
        '',
        'Use this workflow:',
        '1. Call `queryDocs` for the official documentation (prefer an exact Context7 ID such as /vercel/next.js).',
        '2. Call `fetchGithubContent` for the relevant source file, README, release notes, or changelog.',
        '3. If the API changed, compare the current version with the version in the question and mention the breaking change.',
        '4. Prefer a minimal, runnable code example over prose.',
        '',
        'Return: the direct answer, a code example, version constraints, and source links.'
    ].join('\n');
}

export function registerPrompts(server: McpServer): void {
    server.registerPrompt('deep-research', {
        title: 'Deep research',
        description: 'Multi-source research with query fan-out, official docs, and citation-backed synthesis.',
        argsSchema: {
            topic: z.string().min(1).describe('Research topic or question'),
            depth: z.enum(['quick', 'deep']).optional().describe('Research depth (default: deep)')
        }
    }, ({ topic, depth }) => ({
        description: `Deep research: ${topic}`,
        messages: [{
            role: 'user' as const,
            content: { type: 'text' as const, text: buildDeepResearchPrompt(topic, depth ?? 'deep') }
        }]
    }));

    server.registerPrompt('code-lookup', {
        title: 'Code lookup',
        description: 'Look up official docs, source code, and release notes for a library API question.',
        argsSchema: {
            library: z.string().min(1).describe('Library or framework name'),
            question: z.string().min(1).describe('API/usage question')
        }
    }, ({ library, question }) => ({
        description: `Code lookup: ${library}`,
        messages: [{
            role: 'user' as const,
            content: { type: 'text' as const, text: buildCodeLookupPrompt(library, question) }
        }]
    }));
}
