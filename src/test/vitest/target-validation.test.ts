import { describe, it, expect } from 'vitest';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../../core/validation/targetValidation.js';

describe('core/validation/targetValidation', () => {
    it('validates article URLs per site', () => {
        expect(validateArticleUrl('https://blog.csdn.net/user/article/details/123456', 'csdn')).toBe(true);
        expect(validateArticleUrl('https://www.csdn.net/article/details/123456', 'csdn')).toBe(false);

        expect(validateArticleUrl('https://juejin.cn/post/1234567890', 'juejin')).toBe(true);
        expect(validateArticleUrl('https://article.juejin.cn/post/1234567890', 'juejin')).toBe(true);
        expect(validateArticleUrl('https://juejin.cn/pin/1234567890', 'juejin')).toBe(false);
        expect(validateArticleUrl('https://eviljuejin.cn/post/1234567890', 'juejin')).toBe(false);
    });

    it('validates GitHub repository URLs', () => {
        expect(validateGithubRepositoryUrl('https://github.com/Aas-ee/open-webSearch')).toBe(true);
        expect(validateGithubRepositoryUrl('git@github.com:Aas-ee/open-webSearch.git')).toBe(true);
        expect(validateGithubRepositoryUrl('https://github.com/Aas-ee')).toBe(false);
        expect(validateGithubRepositoryUrl('https://gitlab.com/Aas-ee/open-webSearch')).toBe(false);
    });

    it('validates public web URLs and rejects local/non-http targets', () => {
        expect(validatePublicWebUrl('https://example.com/docs')).toBe(true);
        expect(validatePublicWebUrl('http://127.0.0.1:3000')).toBe(false);
        expect(validatePublicWebUrl('file:///etc/passwd')).toBe(false);
    });
});
