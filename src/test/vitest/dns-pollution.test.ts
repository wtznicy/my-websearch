import { describe, expect, it } from 'vitest';
import { stripDnsPollutionAddresses, isDnsPollutionAddress } from '../../utils/urlSafety.js';
import { hintDnsPollutionError } from '../../utils/httpRequest.js';

/**
 * P1-2 回归：运营商可能同时返回真实 A 记录和被伪造的 AAAA（如 2001::1）。
 * 第一层（urlSafety）判定「有公网地址就放行」，第二层（request-filtering-agent）
 * 却把污染地址判成 private 并拒绝——两层结论相反，请求 100% 死在本机。
 * 修法：连接前先把污染地址剔掉，只把可用地址交给第二层。
 */
describe('stripDnsPollutionAddresses', () => {
    it('drops polluted addresses when a public address is available', () => {
        const resolved = [
            { address: '2001::1', family: 6 },
            { address: '185.15.59.224', family: 4 }
        ];
        expect(stripDnsPollutionAddresses(resolved)).toEqual([{ address: '185.15.59.224', family: 4 }]);
    });

    it('drops blackhole and reserved-range addresses', () => {
        const resolved = [
            { address: '0.0.0.0', family: 4 },
            { address: '240.0.0.1', family: 4 },
            { address: '93.184.216.34', family: 4 }
        ];
        expect(stripDnsPollutionAddresses(resolved)).toHaveLength(1);
        expect(stripDnsPollutionAddresses(resolved)[0]?.address).toBe('93.184.216.34');
    });

    it('keeps the list untouched when every address is polluted', () => {
        const resolved = [{ address: '2001::1', family: 6 }];
        expect(stripDnsPollutionAddresses(resolved)).toEqual(resolved);
    });

    it('recognises Teredo as pollution', () => {
        expect(isDnsPollutionAddress('2001::1')).toBe(true);
        expect(isDnsPollutionAddress('93.184.216.34')).toBe(false);
    });
});

describe('hintDnsPollutionError', () => {
    it('maps the agent private-IP rejection into an actionable DNS-pollution hint', () => {
        const error = new Error(
            'DNS lookup 2001::1(family:6, host:en.wikipedia.org) is not allowed. Because, It is private IP address.'
        );
        const hinted = hintDnsPollutionError(error) as { code?: string; message?: string };
        expect(hinted.code).toBe('dns_pollution');
        expect(hinted.message).toContain('DNS pollution');
    });

    it('leaves unrelated errors untouched', () => {
        const error = new Error('status code 404');
        expect(hintDnsPollutionError(error)).toBe(error);
    });
});
