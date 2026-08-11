import {
    searchContext7Libraries,
    fetchContext7Docs,
    normalizeCodeSnippetPageTitle
} from '../engines/context7/context7.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

async function testSearchLibraries(): Promise<void> {
    const result = await searchContext7Libraries('next.js', 'how to implement authentication', 3);
    assert(result.results.length > 0, 'should return at least one library');
    const first = result.results[0];
    assert(first.id.startsWith('/'), 'library id should start with /');
    assert(typeof first.title === 'string' && first.title.length > 0, 'library should have title');
    console.log(`✅ searchContext7Libraries (${result.results.length} matches, top: ${first.title} @ ${first.id})`);
}

async function testFetchDocs(): Promise<void> {
    const result = await fetchContext7Docs('/vercel/next.js', 'how to set up middleware', 3);
    assert(typeof result.libraryId === 'string', 'should return libraryId');
    assert(Array.isArray(result.codeSnippets), 'should return codeSnippets array');
    assert(Array.isArray(result.infoSnippets), 'should return infoSnippets array');
    console.log(`✅ fetchContext7Docs (${result.codeSnippets.length} code snippets, ${result.infoSnippets.length} info snippets)`);
}

async function testFetchDocsInvalidId(): Promise<void> {
    let threw = false;
    try {
        await fetchContext7Docs('next.js', 'x');
    } catch (error) {
        threw = error instanceof Error && error.message.includes('must start with "/"');
    }
    assert(threw, 'library id without leading slash should be rejected');
    console.log('✅ fetchContext7Docs rejects invalid library id');
}

async function testSearchLibrariesWithoutQuery(): Promise<void> {
    // query 可选：只传 libraryName 也应成功（query 兜底为 libraryName）
    const result = await searchContext7Libraries('express', undefined, 3);
    assert(result.results.length > 0, 'should return at least one library without query');
    assert(result.query === '', 'query echo should be empty string when omitted');
    console.log(`✅ searchContext7Libraries without query (${result.results.length} matches, top: ${result.results[0]?.id})`);
}

async function testFetchDocsWithoutQuery(): Promise<void> {
    // query 可选：只传 libraryId 也应成功（query 兜底为 overview）
    const result = await fetchContext7Docs('/vercel/next.js', undefined, 2);
    assert(Array.isArray(result.codeSnippets), 'should return codeSnippets without query');
    assert(result.query === '', 'query echo should be empty string when omitted');
    console.log(`✅ fetchContext7Docs without query (${result.codeSnippets.length} code snippets)`);
}


// 纯单元测试：pageTitle 归一化（不联网）
function testNormalizePageTitle(): void {
    // 1. 正常 pageTitle 原样保留
    const normal = normalizeCodeSnippetPageTitle({ codeTitle: 'A', codeList: [], pageTitle: 'Real Title', codeId: 'https://github.com/x/y.md' });
    assertEqual(normal.pageTitle, 'Real Title', 'normal pageTitle preserved');

    // 2. pageTitle = "Unknown" → 用 codeId 文件名
    const unknown = normalizeCodeSnippetPageTitle({ codeTitle: 'B', codeList: [], pageTitle: 'Unknown', codeId: 'https://github.com/expressjs/express/blob/master/_autodocs/07-middleware-and-routing.md' });
    assertEqual(unknown.pageTitle, '07 middleware and routing', 'Unknown pageTitle falls back to codeId filename');

    // 3. pageTitle 缺失 + codeId 有效 → 用 codeId 文件名
    const missing = normalizeCodeSnippetPageTitle({ codeTitle: 'C', codeList: [], codeId: 'https://example.com/docs/guide.md' });
    assertEqual(missing.pageTitle, 'guide', 'missing pageTitle falls back to codeId filename');

    // 4. pageTitle 缺失 + codeId 为空/无 → 省略 pageTitle 字段
    const noTitle = normalizeCodeSnippetPageTitle({ codeTitle: 'D', codeList: [], codeId: '' });
    assert(noTitle.pageTitle === undefined, 'pageTitle omitted when no fallback available');
    const noCodeId = normalizeCodeSnippetPageTitle({ codeTitle: 'E', codeList: [] });
    assert(noCodeId.pageTitle === undefined, 'pageTitle omitted when codeId missing');

    console.log('✅ normalizeCodeSnippetPageTitle (4 cases)');
}
async function main(): Promise<void> {
    await testSearchLibraries();
    await testFetchDocs();
    await testFetchDocsInvalidId();
    await testSearchLibrariesWithoutQuery();
    await testFetchDocsWithoutQuery();
    testNormalizePageTitle();
    console.log('\nContext7 integration tests passed.');
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
