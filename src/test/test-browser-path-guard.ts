import {
    __getBrowserSubresourceClassificationForTests,
    __resetBrowserSubresourceCacheForTests,
    classifyBrowserSubresourceUrl,
    fetchPageHtmlWithBrowser,
    getBrowserCookieHeader
} from '../utils/browserCookies.js';
import { isFakeIpDnsEnvironment } from './support/fakeIp.js';

async function assertRejects(
    fn: () => Promise<unknown>,
    pattern: RegExp,
    label: string
): Promise<void> {
    try {
        await fn();
    } catch (err: any) {
        const message = err?.message ?? String(err);
        if (!pattern.test(message)) {
            throw new Error(`${label}: rejected with unexpected message "${message}", expected ${pattern}`);
        }
        return;
    }
    throw new Error(`${label}: expected rejection, got success`);
}

async function run(): Promise<void> {
    // TUN/fake-ip 环境（Clash TUN 等）下 DNS 解析路径失真（产品代码用 FAKE_IP_CIDRS 处理该环境）：
    // 所有依赖"域名解析到私网"的用例统一跳过，避免误报失败。
    const skipDnsCases = await isFakeIpDnsEnvironment();
    if (skipDnsCases) {
        console.log('⏭️  TUN/fake-ip DNS detected — DNS-resolved private cases will be skipped');
    }

    // getBrowserCookieHeader must reject before loading Playwright.
    await assertRejects(
        () => getBrowserCookieHeader('http://127.0.0.1/admin'),
        /private or local network/,
        'getBrowserCookieHeader with literal private IPv4'
    );
    console.log('✅ getBrowserCookieHeader rejects literal private IPv4 pre-navigation');

    await assertRejects(
        () => getBrowserCookieHeader('http://[::1]/admin'),
        /private or local network/,
        'getBrowserCookieHeader with bracketed IPv6 loopback'
    );
    console.log('✅ getBrowserCookieHeader rejects [::1] pre-navigation');

    await assertRejects(
        () => getBrowserCookieHeader('http://169.254.169.254/latest/meta-data/'),
        /private or local network/,
        'getBrowserCookieHeader with IMDS'
    );
    console.log('✅ getBrowserCookieHeader rejects IMDS pre-navigation');

    if (!skipDnsCases) {
        // `127.0.0.1.nip.io` 属于"把 IP 编码进域名"的通配 DNS 服务，现在被重绑定规则**先于 DNS 解析**拒绝
        // （不再依赖解析结果），因此接受两种拒绝文案——安全结论一致，仅措辞不同
        await assertRejects(
            () => getBrowserCookieHeader('http://127.0.0.1.nip.io/admin'),
            /private or local network|wildcard DNS|rebinding/i,
            'getBrowserCookieHeader with DNS-resolved private'
        );
        console.log('✅ getBrowserCookieHeader rejects DNS-resolved private pre-navigation');
    }

    // fetchPageHtmlWithBrowser: same coverage.
    await assertRejects(
        () => fetchPageHtmlWithBrowser('http://127.0.0.1/admin'),
        /private or local network/,
        'fetchPageHtmlWithBrowser with literal private IPv4'
    );
    console.log('✅ fetchPageHtmlWithBrowser rejects literal private IPv4 pre-navigation');

    await assertRejects(
        () => fetchPageHtmlWithBrowser('http://[::ffff:7f00:1]/admin'),
        /private or local network/,
        'fetchPageHtmlWithBrowser with IPv4-mapped IPv6 loopback'
    );
    console.log('✅ fetchPageHtmlWithBrowser rejects [::ffff:7f00:1] pre-navigation');

    if (!skipDnsCases) {
        await assertRejects(
            () => fetchPageHtmlWithBrowser('http://127.0.0.1.nip.io/admin'),
            /private or local network|wildcard DNS|rebinding/i,
            'fetchPageHtmlWithBrowser with DNS-resolved private'
        );
        console.log('✅ fetchPageHtmlWithBrowser rejects DNS-resolved private pre-navigation');
    }

    // Subresource guard: literal-private blocked sync, DNS-private blocked via
    // classifyBrowserSubresourceUrl, repeat calls served from the TTL cache.
    __resetBrowserSubresourceCacheForTests();

    await assertRejects(
        () => classifyBrowserSubresourceUrl('http://127.0.0.1/internal.js'),
        /private or local network/,
        'subresource literal private IPv4'
    );
    console.log('✅ subresource guard rejects literal private IPv4');

    await assertRejects(
        () => classifyBrowserSubresourceUrl('http://[::1]/internal.js'),
        /private or local network/,
        'subresource literal IPv6 loopback'
    );
    console.log('✅ subresource guard rejects [::1]');

    await assertRejects(
        () => classifyBrowserSubresourceUrl('http://169.254.169.254/latest/meta-data/'),
        /private or local network/,
        'subresource IMDS'
    );
    console.log('✅ subresource guard rejects IMDS');

    if (!skipDnsCases) {
        await assertRejects(
            () => classifyBrowserSubresourceUrl('http://127.0.0.1.nip.io/img.png'),
            /private or local network|wildcard DNS|rebinding/i,
            'subresource DNS-resolved private'
        );
        console.log('✅ subresource guard rejects DNS-resolved private (first call)');

        if (__getBrowserSubresourceClassificationForTests('127.0.0.1.nip.io') !== false) {
            throw new Error('expected cached negative classification for 127.0.0.1.nip.io');
        }
        console.log('✅ subresource cache stores negative classification');

        await assertRejects(
            () => classifyBrowserSubresourceUrl('http://127.0.0.1.nip.io/img2.png'),
            /private or local network|wildcard DNS|rebinding/i,
            'subresource DNS-resolved private (second call, cached)'
        );
        console.log('✅ subresource guard rejects repeated DNS-resolved private (cache hit)');
    }

    try {
        await classifyBrowserSubresourceUrl('http://8.8.8.8.nip.io/cdn/asset.css');
        if (__getBrowserSubresourceClassificationForTests('8.8.8.8.nip.io') !== true) {
            throw new Error('expected cached positive classification for 8.8.8.8.nip.io');
        }
        console.log('✅ subresource guard allows public DNS-resolved host and caches positive classification');

        // Second call must succeed and stay cached.
        await classifyBrowserSubresourceUrl('http://8.8.8.8.nip.io/cdn/other.js');
        console.log('✅ subresource guard allows repeated public host (cache hit)');
    } catch {
        console.log('⚠️  Skipped public subresource DNS tests — DNS may be behind a proxy (e.g. Clash fake IP mode)');
    }

    console.log('\nBrowser path guard tests passed.');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
