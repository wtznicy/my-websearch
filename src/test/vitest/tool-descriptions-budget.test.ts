import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setupTools } from '../../tools/setupTools.js';
import { createMyWebSearchRuntime } from '../../runtime/createRuntime.js';

describe('Tool Description Token Budget & Length Limit', () => {
    it('all registered tools have description <= 250 chars and total characters <= 1000', () => {
        const server = new McpServer({ name: 'test', version: '1.0.0' });
        const runtime = createMyWebSearchRuntime();
        setupTools(server, runtime);

        // 获取通过 registerTool 注册的工具字典
        // McpServer 内部存储在 _registeredTools
        const registeredTools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
        const toolNames = Object.keys(registeredTools);

        // 必须严格是 5 个工具
        expect(toolNames.sort()).toEqual([
            'codeSymbol',
            'fetchGithubContent',
            'fetchWebContent',
            'queryDocs',
            'search'
        ].sort());

        let totalLength = 0;
        for (const name of toolNames) {
            const desc = registeredTools[name]?.description || '';
            expect(desc.length, `Tool "${name}" description length (${desc.length}) must be <= 250`).toBeLessThanOrEqual(250);
            totalLength += desc.length;
        }

        // 5 个工具的总字符数 <= 1200 字符（约 250-300 tokens）；新增 codeSymbol 后从 1000 上调。
        expect(totalLength, `Total tool descriptions length (${totalLength}) must be <= 1200`).toBeLessThanOrEqual(1200);

        // 首次使用可发现性：名称不能再暗示"只能读 README"，描述必须给出 /blob/ 示例与"非整仓 clone"边界
        const githubDesc = registeredTools['fetchGithubContent']?.description || '';
        expect(githubDesc).toContain('/blob/');
        expect(githubDesc).toContain('Example:');
        expect(githubDesc).toContain('not a repo clone');
    });
});
