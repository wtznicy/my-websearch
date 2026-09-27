import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import {
    getPhysicalInterfaceIpv4,
    resolveRealDomesticHostIp,
    isDomesticHostname,
    isTlsOrWafResetError,
    shouldAttemptDomesticDirectRetry,
    createDomesticDirectAgent,
    clearDomesticNetworkCache
} from '../../utils/domesticDirectNetwork.js';

describe('domesticDirectNetwork', () => {
    beforeEach(() => {
        clearDomesticNetworkCache();
    });

    describe('getPhysicalInterfaceIpv4', () => {
        it('should correctly select physical IPv4 and ignore virtual, loopback, and Fake-IP interfaces', () => {
            const mockInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
                'Meta': [
                    {
                        address: '198.18.0.1',
                        netmask: '255.255.255.252',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:00',
                        internal: false,
                        cidr: '198.18.0.1/30'
                    }
                ],
                'VMware Network Adapter VMnet1': [
                    {
                        address: '192.168.224.1',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '00:50:56:c0:00:01',
                        internal: false,
                        cidr: '192.168.224.1/24'
                    }
                ],
                'Loopback Pseudo-Interface 1': [
                    {
                        address: '127.0.0.1',
                        netmask: '255.0.0.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:00',
                        internal: true,
                        cidr: '127.0.0.1/8'
                    }
                ],
                'WLAN': [
                    {
                        address: '10.211.193.185',
                        netmask: '255.255.0.0',
                        family: 'IPv4',
                        mac: 'dc:97:ba:57:64:67',
                        internal: false,
                        cidr: '10.211.193.185/16'
                    }
                ]
            };

            const selected = getPhysicalInterfaceIpv4(mockInterfaces);
            expect(selected).toBe('10.211.193.185');
        });

        it('should return null when only virtual or fake-ip interfaces exist', () => {
            const mockInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
                'Meta': [
                    {
                        address: '198.18.0.1',
                        netmask: '255.255.255.252',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:00',
                        internal: false,
                        cidr: '198.18.0.1/30'
                    }
                ],
                'Loopback': [
                    {
                        address: '127.0.0.1',
                        netmask: '255.0.0.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:00',
                        internal: true,
                        cidr: '127.0.0.1/8'
                    }
                ]
            };

            const selected = getPhysicalInterfaceIpv4(mockInterfaces);
            expect(selected).toBeNull();
        });
    });

    describe('resolveRealDomesticHostIp', () => {
        it('should resolve public unicast IPv4 via DoH mock', async () => {
            const mockDohFetch = async (_url: string) => {
                return {
                    Status: 0,
                    Answer: [
                        { name: 'blog.csdn.net.', type: 5, data: 'cname.yunduns.com.' },
                        { name: 'cname.yunduns.com.', type: 1, data: '117.149.203.25' }
                    ]
                };
            };

            const ip = await resolveRealDomesticHostIp('blog.csdn.net', mockDohFetch);
            expect(ip).toBe('117.149.203.25');

            // Second call should return cached IP without calling fetch again
            let secondCalled = false;
            const failingFetch = async () => {
                secondCalled = true;
                return null;
            };
            const cachedIp = await resolveRealDomesticHostIp('blog.csdn.net', failingFetch);
            expect(cachedIp).toBe('117.149.203.25');
            expect(secondCalled).toBe(false);
        });

        it('should reject private or loopback IPs returned by DoH (SSRF protection)', async () => {
            const mockDohFetch = async () => {
                return {
                    Status: 0,
                    Answer: [
                        { name: 'malicious.com.', type: 1, data: '192.168.1.1' },
                        { name: 'malicious.com.', type: 1, data: '127.0.0.1' },
                        { name: 'malicious.com.', type: 1, data: '198.18.0.5' }
                    ]
                };
            };

            const ip = await resolveRealDomesticHostIp('malicious.com', mockDohFetch);
            expect(ip).toBeNull();
        });
    });

    describe('isDomesticHostname', () => {
        it('should return true for known domestic domains and .cn suffixes', () => {
            expect(isDomesticHostname('so.csdn.net')).toBe(true);
            expect(isDomesticHostname('blog.csdn.net')).toBe(true);
            expect(isDomesticHostname('juejin.cn')).toBe(true);
            expect(isDomesticHostname('api.juejin.cn')).toBe(true);
            expect(isDomesticHostname('www.baidu.com')).toBe(true);
            expect(isDomesticHostname('www.sogou.com')).toBe(true);
            expect(isDomesticHostname('example.edu.cn')).toBe(true);
        });

        it('should return false for overseas and non-domestic domains', () => {
            expect(isDomesticHostname('google.com')).toBe(false);
            expect(isDomesticHostname('github.com')).toBe(false);
            expect(isDomesticHostname('api.exa.ai')).toBe(false);
            expect(isDomesticHostname('duckduckgo.com')).toBe(false);
            expect(isDomesticHostname('')).toBe(false);
        });
    });

    describe('isTlsOrWafResetError', () => {
        it('should identify TLS handshake reset and WAF disconnection errors', () => {
            expect(isTlsOrWafResetError(new Error('Client network socket disconnected before secure TLS connection was established'))).toBe(true);
            expect(isTlsOrWafResetError(new Error('read ECONNRESET'))).toBe(true);
            expect(isTlsOrWafResetError(new Error('client error (Connect): unexpected EOF'))).toBe(true);
            expect(isTlsOrWafResetError(new Error('socket hang up'))).toBe(true);
            expect(isTlsOrWafResetError(new Error('schannel: remote party requests renegotiation'))).toBe(true);
            expect(isTlsOrWafResetError({ response: { status: 521 } })).toBe(true);
            expect(isTlsOrWafResetError({ response: { status: 522 } })).toBe(true);
            expect(isTlsOrWafResetError({ code: 'ECONNRESET' })).toBe(true);
        });

        it('should return false for unrelated errors', () => {
            expect(isTlsOrWafResetError(new Error('File not found'))).toBe(false);
            expect(isTlsOrWafResetError({ response: { status: 404 } })).toBe(false);
            expect(isTlsOrWafResetError({ response: { status: 200 } })).toBe(false);
            expect(isTlsOrWafResetError(null)).toBe(false);
        });
    });

    describe('shouldAttemptDomesticDirectRetry', () => {
        it('should return true only for domestic hosts with TLS/WAF reset and physical IP available', () => {
            const err = new Error('Client network socket disconnected before secure TLS connection was established');
            expect(shouldAttemptDomesticDirectRetry(err, 'so.csdn.net')).toBe(true);
            expect(shouldAttemptDomesticDirectRetry(err, 'google.com')).toBe(false);
            expect(shouldAttemptDomesticDirectRetry(new Error('404 Not Found'), 'so.csdn.net')).toBe(false);
        });
    });

    describe('createDomesticDirectAgent', () => {
        it('should create an https.Agent bound to physical IP with custom lookup for real IP', async () => {
            const mockDohFetch = async () => ({
                Status: 0,
                Answer: [{ type: 1, data: '117.149.203.48' }]
            });

            const agent = await createDomesticDirectAgent('so.csdn.net', mockDohFetch);
            expect(agent).not.toBeNull();
            expect(agent?.options.keepAlive).toBe(true);
            expect(typeof agent?.options.lookup).toBe('function');

            // Verify the custom lookup callback returns the real resolved IP
            await new Promise<void>((resolve) => {
                agent!.options.lookup!('so.csdn.net', {} as any, (err: any, address: any, family?: number) => {
                    expect(err).toBeNull();
                    expect(address).toBe('117.149.203.48');
                    expect(family).toBe(4);
                    resolve();
                });
            });
        });
    });
});
