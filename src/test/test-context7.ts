import {
    searchContext7Libraries,
    fetchContext7Docs
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

async function main(): Promise<void> {
    await testSearchLibraries();
    await testFetchDocs();
    await testFetchDocsInvalidId();
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
