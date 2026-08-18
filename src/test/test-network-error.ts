import { isNetworkLayerError } from '../utils/httpRequest.js';

function assertEqual(actual: boolean, expected: boolean, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

// 网络层错误 → true（触发代理兜底）
assertEqual(isNetworkLayerError('connect ECONNREFUSED 127.0.0.1:7890'), true, 'ECONNREFUSED is network error');
assertEqual(isNetworkLayerError('timeout of 30000ms exceeded'), true, 'timeout is network error');
assertEqual(isNetworkLayerError('socket hang up'), true, 'socket hang up is network error');
assertEqual(isNetworkLayerError('getaddrinfo ENOTFOUND example.com'), true, 'ENOTFOUND is network error');
assertEqual(isNetworkLayerError('read ECONNRESET'), true, 'ECONNRESET is network error');

// HTTP 状态类错误 → false（不触发代理兜底，保持原有 401/403/429 逻辑）
assertEqual(isNetworkLayerError('Request failed with status code 403'), false, 'HTTP 403 is not network error');
assertEqual(isNetworkLayerError('Request failed with status code 500'), false, 'HTTP 500 is not network error');
assertEqual(isNetworkLayerError('Bing returned a verification or anti-bot page'), false, 'anti-bot page is not network error');

console.log('✅ isNetworkLayerError: all cases passed');
