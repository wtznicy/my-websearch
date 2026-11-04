import { findCodeSymbol } from '../../core/codeIntel/remoteCodeIntel.js';

/**
 * codeSymbol live 测试（真实网络 + GITHUB_TOKEN）。
 *
 * 契约测试只覆盖注册面与不触网分支；成功路径必须在这里验证。
 * 未配置 token 时直接 skip，避免无密钥机器误报失败。
 */
async function main(): Promise<void> {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
        console.log('⏭️  Skipped: GITHUB_TOKEN is not configured.');
        console.log('   Add "github" under apiKeys in ~/.my-websearch/config.json (or export GITHUB_TOKEN), then restart.');
        return;
    }

    const result = await findCodeSymbol({
        repo: 'fastapi/fastapi',
        symbol: 'Depends',
        maxResults: 2
    });

    if (result.definitions.length === 0) {
        throw new Error('codeSymbol returned no definitions for fastapi/fastapi#Depends');
    }
    const definition = result.definitions[0];
    if (!definition.signature.includes('Depends')) {
        throw new Error(`unexpected signature: ${definition.signature}`);
    }
    if (!definition.path.endsWith('.py')) {
        throw new Error(`expected a Python definition, got ${definition.path}`);
    }
    console.log(`✅ codeSymbol live: ${definition.path}:${definition.startLine} ${definition.signature.slice(0, 120)}`);
    console.log(`   references=${result.references.length} callSites=${result.callSites.length} filesScanned=${result.filesScanned}`);
}

main().catch((error) => {
    console.error('❌ codeSymbol live test failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
