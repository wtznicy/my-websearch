import { describe, it, expect } from 'vitest';
import { ErrorCode } from '../../core/errors.js';

describe('ErrorCode', () => {
    it('should have all required error codes', () => {
        expect(ErrorCode.INVALID_ARGUMENTS).toBe('invalid_arguments');
        expect(ErrorCode.NOT_FOUND).toBe('not_found');
        expect(ErrorCode.ENGINE_ERROR).toBe('engine_error');
        expect(ErrorCode.DAEMON_UNAVAILABLE).toBe('daemon_unavailable');
        expect(ErrorCode.DAEMON_TIMEOUT).toBe('daemon_timeout');
        expect(ErrorCode.DAEMON_REQUEST_FAILED).toBe('daemon_request_failed');
        expect(ErrorCode.PAYLOAD_TOO_LARGE).toBe('payload_too_large');
        expect(ErrorCode.UPSTREAM_ERROR).toBe('upstream_error');
        expect(ErrorCode.HTTP_ERROR).toBe('http_error');
        expect(ErrorCode.NETWORK_ERROR).toBe('network_error');
        expect(ErrorCode.EXTRACTION_FAILED).toBe('extraction_failed');
    });

    it('should have unique values', () => {
        const values = Object.values(ErrorCode);
        const uniqueValues = new Set(values);
        expect(uniqueValues.size).toBe(values.length);
    });

    it('should use snake_case naming convention', () => {
        for (const value of Object.values(ErrorCode)) {
            expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
        }
    });
});
