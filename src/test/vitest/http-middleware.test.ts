import { describe, expect, it } from 'vitest';
import { LOOPBACK_HOSTNAMES, resolveAllowedHostnames } from '../../adapters/http/sharedMiddleware.js';

/**
 * Host 白名单是安全相关配置（DNS rebinding 防护），
 * 两个 HTTP 入口共用这套解析——这里锁住它的行为，避免一边放宽。
 */
describe('resolveAllowedHostnames', () => {
    it('defaults to loopback only when nothing is configured', () => {
        expect(resolveAllowedHostnames([], {})).toEqual([...LOOPBACK_HOSTNAMES]);
    });

    it('uses the configured list when present', () => {
        expect(resolveAllowedHostnames([], { OPEN_WEBSEARCH_ALLOWED_HOSTS: 'a.example, b.example' }))
            .toEqual(['a.example', 'b.example']);
    });

    it('appends extra bound hosts without duplicating', () => {
        expect(resolveAllowedHostnames(['127.0.0.1', '0.0.0.0'], {})).toEqual([...LOOPBACK_HOSTNAMES, '0.0.0.0']);
    });

    it('ignores blank entries in the configured list', () => {
        expect(resolveAllowedHostnames([], { OPEN_WEBSEARCH_ALLOWED_HOSTS: ' , a.example ,' }))
            .toEqual(['a.example']);
    });
});
