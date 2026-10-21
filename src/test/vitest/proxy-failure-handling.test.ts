import { describe, expect, it } from 'vitest';
import { isDeterministicProxyFailure, isProxyRelatedFailure } from '../../utils/httpRequest.js';
import { resolveAcceptLanguage, isChineseLocale } from '../../utils/locale.js';

/**
 * 关掉代理后实测到的两个缺口：
 *  1. 死代理的典型失败是「连上了但不回数据」——timeout / TLS eof / socket disconnected，
 *     旧正则一个都不认，所以用户盯着 30 秒却没有任何提示；
 *  2. 这类确定性失败还在重试 3 次（10s × 3），把单次失败放大成 30s。
 */
describe('proxy failure classification', () => {
    it('recognises dead-proxy signatures that are not connection-refused', () => {
        expect(isProxyRelatedFailure('timeout of 3000ms exceeded')).toBe(true);
        expect(isProxyRelatedFailure('Client network socket disconnected before secure TLS connection was established')).toBe(true);
        expect(isProxyRelatedFailure('TLS connect error: error:0A000126:SSL routines::unexpected eof while reading')).toBe(true);
        expect(isProxyRelatedFailure('connect ECONNREFUSED 127.0.0.1:7897')).toBe(true);
    });

    it('does not treat ordinary upstream errors as proxy failures', () => {
        expect(isProxyRelatedFailure('Response body too large (3000000 bytes)')).toBe(false);
        expect(isProxyRelatedFailure('status code 404')).toBe(false);
    });

    it('marks connection-level failures as deterministic (no point retrying)', () => {
        expect(isDeterministicProxyFailure('connect ECONNREFUSED 127.0.0.1:7897')).toBe(true);
        expect(isDeterministicProxyFailure('TLS connect error: unexpected eof while reading')).toBe(true);
        expect(isDeterministicProxyFailure('Client network socket disconnected before secure TLS connection was established')).toBe(true);
    });

    it('keeps plain timeouts retryable, since a slow site is not a dead proxy', () => {
        expect(isDeterministicProxyFailure('timeout of 3000ms exceeded')).toBe(false);
    });
});

/**
 * 外国用户默认拿到的页面语言不该被硬编码成中文。
 */
describe('resolveAcceptLanguage', () => {
    it('honours an explicit ACCEPT_LANGUAGE override', () => {
        expect(resolveAcceptLanguage({ ACCEPT_LANGUAGE: 'de-DE,de;q=0.9' })).toBe('de-DE,de;q=0.9');
    });

    it('falls back to a non-Chinese value on a non-zh machine', () => {
        const value = resolveAcceptLanguage({});
        expect(value).toMatch(/^[a-zA-Z]{2,3}(-[A-Za-z0-9]+)?,.+;q=0\.9,en;q=0\.8$/);
    });

    it('never returns an empty header', () => {
        expect(resolveAcceptLanguage({}).length).toBeGreaterThan(3);
    });

    it('detects a Chinese locale without throwing', () => {
        expect(typeof isChineseLocale({})).toBe('boolean');
    });
});
