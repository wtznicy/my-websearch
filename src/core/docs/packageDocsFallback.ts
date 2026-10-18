import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';

export type PackageDocsFallbackResult = {
    source: 'npm' | 'pypi' | 'github-readme';
    confidence: 'high' | 'medium' | 'low';
    libraryId: string;
    repositoryUrl: string;
    readme: string;
    warnings: string[];
};

/**
 * 将 npm / PyPI 中的 repository 字段归一化为规范的 GitHub / Gitee HTTPS URL。
 */
export function normalizeGitRepositoryUrl(raw: string): string | null {
    if (!raw) return null;
    let s = raw.trim();

    if (s.startsWith('github:')) {
        return `https://github.com/${s.slice(7).replace(/\.git$/i, '')}`;
    }
    if (s.startsWith('gitlab:')) {
        return `https://gitlab.com/${s.slice(7).replace(/\.git$/i, '')}`;
    }
    if (s.startsWith('bitbucket:')) {
        return `https://bitbucket.org/${s.slice(10).replace(/\.git$/i, '')}`;
    }

    s = s.replace(/^git\+/, '');
    s = s.replace(/^ssh:\/\/git@github\.com[/:]/, 'https://github.com/');
    s = s.replace(/^git@github\.com:/, 'https://github.com/');
    s = s.replace(/^git:\/\/github\.com\//, 'https://github.com/');
    s = s.replace(/^git@gitee\.com:/, 'https://gitee.com/');
    s = s.replace(/^git:\/\/gitee\.com\//, 'https://gitee.com/');

    if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(s)) {
        return `https://github.com/${s.replace(/\.git$/i, '')}`;
    }

    try {
        const u = new URL(s);
        if (u.hostname.includes('github.com') || u.hostname.includes('gitee.com')) {
            const pathname = u.pathname.replace(/\.git$/i, '');
            return `https://${u.hostname}${pathname}`;
        }
    } catch {
        // not a valid URL
    }
    return null;
}

/**
 * 从 npm registry 查询包信息并提取源码仓库 URL。
 */
export async function resolveNpmRepository(packageName: string, signal?: AbortSignal): Promise<string | null> {
    const clean = packageName.trim().replace(/^@/, '').split('@')[0]?.trim();
    if (!clean) return null;

    // 支持 scoped 包（如 @types/node 变为 @types%2fnode 或直接传入）
    const pkgTarget = packageName.startsWith('@')
        ? `@${encodeURIComponent(clean)}`
        : encodeURIComponent(clean);

    const url = `https://registry.npmjs.org/${pkgTarget}`;
    try {
        const response = await requestDirectFirst(
            'GET',
            url,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 4000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            'npm registry'
        );

        if (response.status !== 200 || !response.data) {
            return null;
        }

        const data = response.data as {
            repository?: string | { url?: string };
            homepage?: string;
        };

        let repoStr = '';
        if (typeof data.repository === 'string') {
            repoStr = data.repository;
        } else if (data.repository && typeof data.repository === 'object' && data.repository.url) {
            repoStr = data.repository.url;
        } else if (data.homepage && (data.homepage.includes('github.com') || data.homepage.includes('gitee.com'))) {
            repoStr = data.homepage;
        }

        return normalizeGitRepositoryUrl(repoStr);
    } catch {
        return null;
    }
}

/**
 * 从 PyPI JSON API 查询包信息并提取源码仓库 URL。
 */
export async function resolvePypiRepository(packageName: string, signal?: AbortSignal): Promise<string | null> {
    const clean = packageName.trim().split('@')[0]?.trim();
    if (!clean) return null;

    const url = `https://pypi.org/pypi/${encodeURIComponent(clean)}/json`;
    try {
        const response = await requestDirectFirst(
            'GET',
            url,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 4000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            'PyPI JSON API'
        );

        if (response.status !== 200 || !response.data) {
            return null;
        }

        const data = response.data as {
            info?: {
                project_urls?: Record<string, string>;
                home_page?: string;
                package_url?: string;
            };
        };

        const info = data.info;
        if (!info) return null;

        const candidateUrls: string[] = [];
        if (info.project_urls && typeof info.project_urls === 'object') {
            for (const [key, val] of Object.entries(info.project_urls)) {
                if (typeof val === 'string') {
                    const lk = key.toLowerCase();
                    if (lk.includes('source') || lk.includes('repo') || lk.includes('code') || lk.includes('home') || lk.includes('github')) {
                        candidateUrls.unshift(val);
                    } else {
                        candidateUrls.push(val);
                    }
                }
            }
        }
        if (info.home_page) {
            candidateUrls.push(info.home_page);
        }

        for (const candidate of candidateUrls) {
            const normalized = normalizeGitRepositoryUrl(candidate);
            if (normalized) {
                return normalized;
            }
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 当 Context7 命中低置信度或不存在时，依次向 npm 和 PyPI 兜底，
 * 通过提取到的 Git 仓库直接抓取官方 README。
 */
export async function fetchPackageDocsFallback(options: {
    library: string;
    signal?: AbortSignal;
    fetchGithub: (url: string) => Promise<string | null>;
}): Promise<PackageDocsFallbackResult | null> {
    const rawTarget = options.library.trim();
    // 剔除前后斜杠（如果是 Context7 库名形式如 /owner/repo，直接提取 repo）
    const cleanTarget = rawTarget.startsWith('/')
        ? rawTarget.replace(/^\/+/, '').split('/')[1] || rawTarget.replace(/^\/+/, '')
        : rawTarget;

    // 1. 尝试 npm 注册表
    try {
        const npmRepo = await resolveNpmRepository(cleanTarget, options.signal);
        if (npmRepo) {
            const readme = await options.fetchGithub(npmRepo);
            if (readme && readme.trim().length > 50) {
                return {
                    source: 'npm',
                    confidence: 'high',
                    libraryId: cleanTarget,
                    repositoryUrl: npmRepo,
                    readme: readme.trim(),
                    warnings: [
                        `Context7 match confidence was low or library was not found in Context7. Fallback to npm package repository (${npmRepo}) README.`
                    ]
                };
            }
        }
    } catch {
        // npm fallback failed, continue to PyPI
    }

    // 2. 尝试 PyPI
    try {
        const pypiRepo = await resolvePypiRepository(cleanTarget, options.signal);
        if (pypiRepo) {
            const readme = await options.fetchGithub(pypiRepo);
            if (readme && readme.trim().length > 50) {
                return {
                    source: 'pypi',
                    confidence: 'high',
                    libraryId: cleanTarget,
                    repositoryUrl: pypiRepo,
                    readme: readme.trim(),
                    warnings: [
                        `Context7 match confidence was low or library was not found in Context7. Fallback to PyPI package repository (${pypiRepo}) README.`
                    ]
                };
            }
        }
    } catch {
        // PyPI fallback failed
    }

    return null;
}
