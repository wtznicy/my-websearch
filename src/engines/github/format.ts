/**
 * Shared formatting helpers for GitHub / Gitee content.
 * Kept dependency-free so both host adapters can import them without cycles.
 */

/** 从文件路径推断 Markdown 围栏代码块语言标识 */
export function detectLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        json: 'json',
        jsonc: 'json',
        py: 'python',
        rs: 'rust',
        go: 'go',
        java: 'java',
        c: 'c',
        cpp: 'cpp',
        cc: 'cpp',
        h: 'c',
        hpp: 'cpp',
        cs: 'csharp',
        rb: 'ruby',
        php: 'php',
        swift: 'swift',
        kt: 'kotlin',
        kts: 'kotlin',
        sh: 'bash',
        bash: 'bash',
        zsh: 'bash',
        yaml: 'yaml',
        yml: 'yaml',
        md: 'markdown',
        markdown: 'markdown',
        mdx: 'mdx',
        toml: 'toml',
        sql: 'sql',
        html: 'html',
        css: 'css',
        scss: 'scss',
        less: 'less',
        vue: 'vue',
        svelte: 'svelte',
        graphql: 'graphql',
        gql: 'graphql',
        proto: 'protobuf',
        xml: 'xml',
        dockerfile: 'dockerfile',
        makefile: 'makefile'
    };
    return map[ext] || '';
}

export function formatSourceFile(owner: string, repo: string, branch: string, filePath: string, content: string): string {
    const isMd = /\.mdx?$/i.test(filePath) || /\.markdown$/i.test(filePath);
    if (isMd) {
        return `# File: \`${filePath}\` (${owner}/${repo} @ ${branch})\n\n${content}`;
    }
    const lang = detectLanguageFromPath(filePath);
    return `# File: \`${filePath}\` (${owner}/${repo} @ ${branch})\n\n\`\`\`${lang}\n${content}\n\`\`\``;
}

/** 渲染小巧精美的 ASCII 目录树 */
export function renderAsciiTree(items: Array<{ path: string; type: 'blob' | 'tree'; size?: number }>): string {
    interface TreeNode {
        name: string;
        type: 'blob' | 'tree';
        size?: number;
        children: Map<string, TreeNode>;
    }
    const root: TreeNode = { name: '', type: 'tree', children: new Map() };

    for (const item of items) {
        const parts = item.path.split('/').filter(Boolean);
        let current = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i]!;
            const isLast = i === parts.length - 1;
            if (!current.children.has(part)) {
                current.children.set(part, {
                    name: part,
                    type: isLast ? item.type : 'tree',
                    size: isLast ? item.size : undefined,
                    children: new Map()
                });
            }
            current = current.children.get(part)!;
        }
    }

    const lines: string[] = [];
    function formatSize(bytes?: number): string {
        if (typeof bytes !== 'number') return '';
        if (bytes < 1024) return ` (${bytes} B)`;
        if (bytes < 1024 * 1024) return ` (${(bytes / 1024).toFixed(1)} KB)`;
        return ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
    }

    function traverse(node: TreeNode, prefix: string, isTail: boolean, isRoot: boolean) {
        if (!isRoot) {
            const icon = node.type === 'tree' ? '📁 ' : '📄 ';
            const connector = isTail ? '└── ' : '├── ';
            lines.push(`${prefix}${connector}${icon}${node.name}${formatSize(node.size)}`);
        }
        const children = Array.from(node.children.values());
        children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        const newPrefix = isRoot ? '' : prefix + (isTail ? '    ' : '│   ');
        for (let i = 0; i < children.length; i++) {
            traverse(children[i]!, newPrefix, i === children.length - 1, false);
        }
    }

    traverse(root, '', true, true);
    return lines.join('\n');
}
