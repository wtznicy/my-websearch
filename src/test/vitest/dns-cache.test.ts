import { describe, it, expect, afterEach } from 'vitest';
import { cachedDnsLookup, __setDnsLookupForTests, peekCachedLookup } from '../../utils/dnsCache.js';

function lookupOnce(hostname: string): Promise<string[] | null> {
    return new Promise((resolve) => {
        cachedDnsLookup(hostname, { all: true }, (err, address) => {
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

afterEach(() => {
    __setDnsLookupForTests();
});

describe('utils/dnsCache', () => {
    it('caches successful lookups and exposes them via peek', async () => {
        let lookupCalls = 0;
        __setDnsLookupForTests((_hostname, _options, callback) => {
            lookupCalls += 1;
            callback(null, '93.184.216.34', 4);
        });

        expect(await lookupOnce('cache-hit.example')).toEqual(['93.184.216.34']);
        expect(lookupCalls).toBe(1);
        expect(await lookupOnce('cache-hit.example')).toEqual(['93.184.216.34']);
        expect(lookupCalls).toBe(1);

        expect(peekCachedLookup('cache-hit.example')).toEqual(['93.184.216.34']);
        expect(peekCachedLookup('never-looked-up.example')).toBeUndefined();
    });

    it('does not cache failed lookups', async () => {
        let lookupCalls = 0;
        __setDnsLookupForTests((_hostname, _options, callback) => {
            lookupCalls += 1;
            const error = new Error('ENOTFOUND') as NodeJS.ErrnoException;
            error.code = 'ENOTFOUND';
            (callback as (err: NodeJS.ErrnoException | null) => void)(error);
        });

        expect(await lookupOnce('missing.example')).toBeNull();
        expect(await lookupOnce('missing.example')).toBeNull();
        expect(lookupCalls).toBe(2);
        expect(peekCachedLookup('missing.example')).toBeUndefined();
    });
});
