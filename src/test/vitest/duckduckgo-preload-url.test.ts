import { describe, it, expect } from 'vitest';
import { isTrustedDuckDuckGoPreloadUrl } from '../../engines/duckduckgo/duckduckgo.js';

describe('DuckDuckGo preload URL trust', () => {
    it('accepts the canonical HTTPS d.js endpoint', () => {
        expect(isTrustedDuckDuckGoPreloadUrl('https://links.duckduckgo.com/d.js')).toBe(true);
        expect(isTrustedDuckDuckGoPreloadUrl('https://links.duckduckgo.com:443/d.js?foo=bar')).toBe(true);
    });

    it('rejects non-default ports, credentials, other paths and plain HTTP', () => {
        expect(isTrustedDuckDuckGoPreloadUrl('https://links.duckduckgo.com:444/d.js')).toBe(false);
        expect(isTrustedDuckDuckGoPreloadUrl('https://user:pass@links.duckduckgo.com/d.js')).toBe(false);
        expect(isTrustedDuckDuckGoPreloadUrl('https://links.duckduckgo.com/other.js')).toBe(false);
        expect(isTrustedDuckDuckGoPreloadUrl('http://links.duckduckgo.com/d.js')).toBe(false);
    });
});
