import { describe, it, expect, afterEach } from 'vitest';
import {
    __setDnsLookupForTests,
    assertPublicHttpUrlResolved,
    isPublicHttpUrl,
    isPrivateOrLocalHostname
} from '../../utils/urlSafety.js';
import { config } from '../../config.js';

afterEach(() => {
    __setDnsLookupForTests();
});

describe('utils/urlSafety host classification', () => {
    it.each([
        ['localhost'],
        ['127.0.0.1'],
        ['10.0.0.5'],
        ['172.20.1.8'],
        ['192.168.1.1'],
        ['169.254.169.254'],
        ['::1'],
        ['fd00::1']
    ])('treats %s as private/local', (host) => {
        expect(isPrivateOrLocalHostname(host)).toBe(true);
    });

    it.each([
        ['example.com'],
        ['8.8.8.8']
    ])('treats %s as public', (host) => {
        expect(isPrivateOrLocalHostname(host)).toBe(false);
    });
});

describe('utils/urlSafety URL classification', () => {
    it.each([
        ['https://example.com/skill.md', true],
        ['http://8.8.8.8/resource', true],
        ['ftp://example.com/file', false],
        ['http://localhost:3000/secret', false],
        ['http://127.0.0.1/admin', false],
        ['http://169.254.169.254/latest/meta-data', false]
    ])('isPublicHttpUrl(%s) -> %s', (url, expected) => {
        expect(isPublicHttpUrl(url)).toBe(expected);
    });

    it.each([
        'http://[::1]/',
        'http://[::]/',
        'http://[::ffff:127.0.0.1]/',
        'http://[::ffff:7f00:1]/',
        'http://[0:0:0:0:0:ffff:127.0.0.1]/',
        'http://[0:0:0:0:0:0:0:1]/',
        'http://[::0:1]/',
        'http://[0:0::1]/',
        'http://[::ffff:a00:1]/',
        'http://[::ffff:c0a8:1]/',
        'http://[::ffff:a9fe:1]/',
        'http://[::ffff:169.254.169.254]/latest/meta-data'
    ])('blocks advisory IPv4-mapped bypass vector %s', (url) => {
        expect(isPublicHttpUrl(url)).toBe(false);
    });

    it.each([
        'http://[2001:4860:4860::8888]/',
        'https://[2606:4700:4700::1111]/',
        'https://example.com/'
    ])('allows public control URL %s', (url) => {
        expect(isPublicHttpUrl(url)).toBe(true);
    });
});

describe('utils/urlSafety FAKE_IP_CIDRS handling', () => {
    it('allows fake-IP answers but keeps private answers and literal private IPs blocked', async () => {
        const previousFakeIpCidrs = [...config.fakeIpCidrs];
        config.fakeIpCidrs = ['198.18.0.0/15'];
        __setDnsLookupForTests(async (hostname) => {
            const answers: Record<string, string> = {
                'fake-ip.example': '198.18.1.2',
                'private-ip.example': '127.0.0.1',
                'lan-ip.example': '192.168.1.10',
                'public-ip.example': '8.8.8.8'
            };
            if (!answers[hostname]) {
                throw new Error(`unexpected hostname: ${hostname}`);
            }
            return [{ address: answers[hostname] }];
        });

        try {
            await expect(assertPublicHttpUrlResolved('https://fake-ip.example/')).resolves.toBeUndefined();
            await expect(assertPublicHttpUrlResolved('https://private-ip.example/')).rejects.toThrow();
            await expect(assertPublicHttpUrlResolved('https://lan-ip.example/')).rejects.toThrow();
            await expect(assertPublicHttpUrlResolved('https://public-ip.example/')).resolves.toBeUndefined();
            await expect(assertPublicHttpUrlResolved('https://127.0.0.1/')).rejects.toThrow();
        } finally {
            config.fakeIpCidrs = previousFakeIpCidrs;
        }
    });
});
