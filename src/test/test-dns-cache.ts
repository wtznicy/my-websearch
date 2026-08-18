import { cachedDnsLookup, __setDnsLookupForTests, peekCachedLookup } from '../utils/dnsCache.js';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function lookupOnce(hostname: string, options: { all?: boolean } = {}): Promise<string[] | null> {
    return new Promise((resolve) => {
        cachedDnsLookup(hostname, { all: options.all ?? false }, (err, address) => {
            if (err) {
                resolve(null);
                return;
            }
            if (Array.isArray(address)) {
                resolve(address.map((item) => (typeof item === 'string' ? item : item.address)));
            } else {
                resolve([address]);
            }
        });
    });
}

async function runDnsCacheCases(): Promise<void> {
    // mock 底层解析：记录调用次数，返回固定地址
    let lookupCalls = 0;
    __setDnsLookupForTests((hostname, _options, callback) => {
        lookupCalls += 1;
        callback(null, '93.184.216.34', 4);
    });

    // 1. 首次解析走底层；第二次命中缓存不再调用底层
    const first = await lookupOnce('example.com');
    assertEqual(first, ['93.184.216.34'], 'first lookup resolves');
    assertEqual(lookupCalls, 1, 'first lookup invokes underlying resolver');
    const second = await lookupOnce('example.com');
    assertEqual(second, ['93.184.216.34'], 'second lookup returns same address');
    assertEqual(lookupCalls, 1, 'second lookup hits cache (no underlying call)');

    // 2. peekCachedLookup 同步读取缓存
    const peeked = peekCachedLookup('example.com');
    assertEqual(peeked, ['93.184.216.34'], 'peekCachedLookup returns cached addresses');
    assertEqual(peekCachedLookup('unknown-host.test'), undefined, 'peekCachedLookup returns undefined for uncached host');

    // 3. 解析失败不缓存（下次重新调用底层）
    __setDnsLookupForTests((hostname, _options, callback) => {
        lookupCalls += 1;
        const error = new Error('ENOTFOUND') as NodeJS.ErrnoException;
        error.code = 'ENOTFOUND';
        (callback as (err: NodeJS.ErrnoException | null) => void)(error);
    });
    const failed = await lookupOnce('not-exist.test');
    assertEqual(failed, null, 'failed lookup returns null');
    const failedAgain = await lookupOnce('not-exist.test');
    assertEqual(failedAgain, null, 'failed lookup returns null again');
    assertEqual(lookupCalls, 3, 'failed results are not cached (underlying called again)');

    // 4. 恢复真实解析，清理 mock
    __setDnsLookupForTests();
    console.log('✅ dnsCache: hit/peek/failure-no-cache all passed');
}

await runDnsCacheCases();
