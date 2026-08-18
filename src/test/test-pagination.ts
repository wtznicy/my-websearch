import { paginateSearch } from '../utils/pagination.js';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

async function runPaginationCases(): Promise<void> {
    // 1. 基本收集：两页 3+3=6 条，limit=5 截断为 5 条
    let pageCalls = 0;
    const r1 = await paginateSearch({
        limit: 5,
        fetchPage: async (pageIndex) => {
            pageCalls += 1;
            return [0, 1, 2].map((n) => pageIndex * 10 + n);
        }
    });
    assertEqual(r1, [0, 1, 2, 10, 11], 'collects across pages and slices to limit');
    assertEqual(pageCalls, 2, 'stops after limit reached');

    // 2. 空页提前终止（不再请求下一页）
    let emptyPageCalls = 0;
    const r2 = await paginateSearch({
        limit: 10,
        fetchPage: async () => {
            emptyPageCalls += 1;
            return emptyPageCalls === 1 ? [1, 2] : [];
        }
    });
    assertEqual(r2, [1, 2], 'empty page breaks the loop');
    assertEqual(emptyPageCalls, 2, 'empty page stops further fetches');

    // 3. maxPages 安全阀：持续有结果但 maxPages=2 时只抓 2 页
    let cappedCalls = 0;
    const r3 = await paginateSearch({
        limit: 100,
        maxPages: 2,
        fetchPage: async () => {
            cappedCalls += 1;
            return [1];
        }
    });
    assertEqual(cappedCalls, 2, 'maxPages caps the loop');
    assertEqual(r3, [1, 1], 'collects what was fetched');

    // 4. pageStep：页码按步长递增
    const pagesSeen: number[] = [];
    await paginateSearch({
        limit: 100,
        maxPages: 3,
        pageStep: 10,
        fetchPage: async (pageIndex) => {
            pagesSeen.push(pageIndex);
            return [pageIndex];
        }
    });
    assertEqual(pagesSeen, [0, 10, 20], 'pageStep increments page index');

    console.log('✅ paginateSearch: collect/empty-break/maxPages/pageStep all passed');
}

await runPaginationCases();
