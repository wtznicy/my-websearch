import { isPublicHttpUrl } from '../../utils/urlSafety.js';

export function validateArticleUrl(url: string, type: 'csdn' | 'juejin'): boolean {
    try {
        const urlObj = new URL(url);

        switch (type) {
            case 'csdn':
                // 用 pathname 而非完整 url 判断，避免 query 参数伪造路径（如 /article/details/ 出现在 ?next= 中）
                return urlObj.hostname === 'blog.csdn.net' && urlObj.pathname.includes('/article/details/');
            case 'juejin':
                return urlObj.hostname === 'juejin.cn' && urlObj.pathname.includes('/post/');
            default:
                return false;
        }
    } catch {
        return false;
    }
}

export function validateGithubRepositoryUrl(url: string): boolean {
    try {
        const trimmedUrl = url.trim();

        // GitHub / Gitee 的 HTTPS 与 SSH 格式
        if (/^git@(github|gitee)\.com:/.test(trimmedUrl)) {
            return /^git@(github|gitee)\.com:[^\/]+\/[^\/]+/.test(trimmedUrl);
        }

        const urlObj = new URL(trimmedUrl);
        const isSupportedHost = urlObj.hostname === 'github.com'
            || urlObj.hostname === 'www.github.com'
            || urlObj.hostname === 'gitee.com'
            || urlObj.hostname === 'www.gitee.com';
        if (!isSupportedHost) {
            return false;
        }

        const pathParts = urlObj.pathname.split('/').filter((part) => part.length > 0);
        return pathParts.length >= 2;
    } catch {
        return false;
    }
}

export function validatePublicWebUrl(url: string): boolean {
    return isPublicHttpUrl(url);
}
