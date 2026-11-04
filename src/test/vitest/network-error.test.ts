import { describe, it, expect } from 'vitest';
import { isNetworkLayerError } from '../../utils/httpRequest.js';

describe('utils/httpRequest isNetworkLayerError', () => {
    it('classifies transport failures as network errors', () => {
        expect(isNetworkLayerError('connect ECONNREFUSED 127.0.0.1:7890')).toBe(true);
        expect(isNetworkLayerError('timeout of 30000ms exceeded')).toBe(true);
        expect(isNetworkLayerError('socket hang up')).toBe(true);
        expect(isNetworkLayerError('getaddrinfo ENOTFOUND example.com')).toBe(true);
        expect(isNetworkLayerError('read ECONNRESET')).toBe(true);
    });

    it('keeps HTTP status and anti-bot errors out of network fallback', () => {
        expect(isNetworkLayerError('Request failed with status code 403')).toBe(false);
        expect(isNetworkLayerError('Request failed with status code 500')).toBe(false);
        expect(isNetworkLayerError('Bing returned a verification or anti-bot page')).toBe(false);
    });
});
