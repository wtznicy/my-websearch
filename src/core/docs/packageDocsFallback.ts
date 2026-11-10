import { buildAxiosRequestOptions, requestDirectFirst } from '../../utils/httpRequest.js';

export type PackageMetadata = {
    source: 'npm' | 'pypi' | 'crates' | 'go' | 'maven';
    libraryId: string;
    version?: string;
    repositoryUrl?: string | null;
    documentationUrl?: string | null;
    homepageUrl?: string | null;
};

export type PackageDocsFallbackResult = {
    source: 'npm' | 'pypi' | 'crates' | 'go' | 'maven' | 'github-readme';
    confidence: 'high' | 'medium' | 'low';
    libraryId: string;
    repositoryUrl: string;
    readme: string;
    warnings: string[];
    documentationUrl?: string | null;
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
    s = s.replace(/^scm:git:/, '');
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
 * 从 npm registry 查询包信息并提取完整元数据（源码仓库、官方文档站、首页）。
 */
export async function resolveNpmMetadata(packageName: string, signal?: AbortSignal, version?: string): Promise<PackageMetadata | null> {
    const clean = packageName.trim().replace(/^@/, '').split('@')[0]?.trim();
    if (!clean) return null;

    // 支持 scoped 包（如 @types/node 变为 @types%2fnode 或直接传入）
    const pkgTarget = packageName.startsWith('@')
        ? `@${encodeURIComponent(clean)}`
        : encodeURIComponent(clean);

    const url = version
        ? `https://registry.npmjs.org/${pkgTarget}/${encodeURIComponent(version)}`
        : `https://registry.npmjs.org/${pkgTarget}`;
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

        const repositoryUrl = normalizeGitRepositoryUrl(repoStr);
        let homepageUrl: string | null = null;
        let documentationUrl: string | null = null;

        if (typeof data.homepage === 'string' && /^https?:\/\//i.test(data.homepage)) {
            homepageUrl = data.homepage;
            if (!data.homepage.includes('github.com') && !data.homepage.includes('gitee.com')) {
                documentationUrl = data.homepage;
            }
        }

        return {
            source: 'npm',
            libraryId: clean,
            version,
            repositoryUrl,
            documentationUrl,
            homepageUrl
        };
    } catch {
        return null;
    }
}

/**
 * 从 npm registry 查询包信息并提取源码仓库 URL。
 */
export async function resolveNpmRepository(packageName: string, signal?: AbortSignal, version?: string): Promise<string | null> {
    const meta = await resolveNpmMetadata(packageName, signal, version);
    return meta?.repositoryUrl ?? null;
}

/**
 * 从 PyPI JSON API 查询包信息并提取完整元数据。
 */
export async function resolvePypiMetadata(packageName: string, signal?: AbortSignal, version?: string): Promise<PackageMetadata | null> {
    const clean = packageName.trim().replace(/^pypi:/, '').split('@')[0]?.trim();
    if (!clean) return null;

    const url = version
        ? `https://pypi.org/pypi/${encodeURIComponent(clean)}/${encodeURIComponent(version)}/json`
        : `https://pypi.org/pypi/${encodeURIComponent(clean)}/json`;
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
                documentation_url?: string;
                package_url?: string;
                version?: string;
            };
        };

        const info = data.info;
        if (!info) return null;

        const candidateUrls: string[] = [];
        let documentationUrl: string | null = null;
        let homepageUrl: string | null = null;

        if (info.project_urls && typeof info.project_urls === 'object') {
            for (const [key, val] of Object.entries(info.project_urls)) {
                if (typeof val === 'string' && /^https?:\/\//i.test(val)) {
                    const lk = key.toLowerCase();
                    if (lk.includes('doc') && !documentationUrl) {
                        documentationUrl = val;
                    }
                    if ((lk.includes('home') || lk === 'homepage') && !homepageUrl) {
                        homepageUrl = val;
                    }
                    if (lk.includes('source') || lk.includes('repo') || lk.includes('code') || lk.includes('home') || lk.includes('github')) {
                        candidateUrls.unshift(val);
                    } else {
                        candidateUrls.push(val);
                    }
                }
            }
        }
        if (info.home_page && /^https?:\/\//i.test(info.home_page)) {
            candidateUrls.push(info.home_page);
            if (!homepageUrl) homepageUrl = info.home_page;
        }
        if (info.documentation_url && /^https?:\/\//i.test(info.documentation_url) && !documentationUrl) {
            documentationUrl = info.documentation_url;
        }

        let repositoryUrl: string | null = null;
        for (const candidate of candidateUrls) {
            const normalized = normalizeGitRepositoryUrl(candidate);
            if (normalized) {
                repositoryUrl = normalized;
                break;
            }
        }

        return {
            source: 'pypi',
            libraryId: clean,
            version: version || info.version,
            repositoryUrl,
            documentationUrl: documentationUrl || (homepageUrl && !homepageUrl.includes('github.com') ? homepageUrl : null),
            homepageUrl
        };
    } catch {
        return null;
    }
}

/**
 * 从 PyPI JSON API 查询包信息并提取源码仓库 URL。
 */
export async function resolvePypiRepository(packageName: string, signal?: AbortSignal, version?: string): Promise<string | null> {
    const meta = await resolvePypiMetadata(packageName, signal, version);
    return meta?.repositoryUrl ?? null;
}

/**
 * 从 crates.io 查询 crate 信息并提取完整元数据。
 */
export async function resolveCratesMetadata(packageName: string, signal?: AbortSignal, version?: string): Promise<PackageMetadata | null> {
    const clean = packageName.trim().replace(/^crates?:/, '').split('@')[0]?.trim();
    if (!clean) return null;

    const url = `https://crates.io/api/v1/crates/${encodeURIComponent(clean)}`;
    try {
        const response = await requestDirectFirst(
            'GET',
            url,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 5000,
                responseType: 'json',
                signal,
                forceDirect,
                headers: {
                    'User-Agent': 'my-websearch (+https://github.com/wtznicy/my-websearch)',
                    'Accept': 'application/json'
                }
            }),
            'crates.io API'
        );

        if (response.status !== 200 || !response.data) {
            return null;
        }

        const data = response.data as {
            crate?: {
                repository?: string;
                homepage?: string;
                documentation?: string;
                max_version?: string;
            };
        };
        const crate = data.crate;
        if (!crate) {
            return null;
        }
        const repo = crate.repository
            || (crate.homepage && (crate.homepage.includes('github.com') || crate.homepage.includes('gitee.com')) ? crate.homepage : '')
            || '';
        const repositoryUrl = normalizeGitRepositoryUrl(repo);
        const resolvedVersion = version || crate.max_version;
        const docsRsUrl = `https://docs.rs/${encodeURIComponent(clean)}${resolvedVersion ? '/' + encodeURIComponent(resolvedVersion) : ''}`;
        const documentationUrl = crate.documentation || docsRsUrl;

        return {
            source: 'crates',
            libraryId: clean,
            version: resolvedVersion,
            repositoryUrl,
            documentationUrl,
            homepageUrl: crate.homepage || null
        };
    } catch {
        return null;
    }
}

/**
 * 从 crates.io 查询 crate 信息并提取源码仓库 URL。
 * crates.io 要求请求带 User-Agent；version 仅用于展示/提示，仓库地址来自 crate 元数据。
 */
export async function resolveCratesRepository(packageName: string, signal?: AbortSignal): Promise<string | null> {
    const meta = await resolveCratesMetadata(packageName, signal);
    return meta?.repositoryUrl ?? null;
}

/**
 * 解析 Maven 坐标：groupId:artifactId[:version]。
 * 仅接受标准坐标形态，避免把 npm scope（@scope/pkg）误判为 Maven。
 */
export function parseMavenCoordinates(raw: string): { groupId: string; artifactId: string; version?: string } | null {
    const parts = raw.trim().split(':').map((part) => part.trim());
    if (parts.length < 2 || parts.length > 3) {
        return null;
    }
    const [groupId, artifactId, version] = parts;
    const valid = /^[A-Za-z0-9_.-]+$/;
    if (!groupId || !artifactId || !valid.test(groupId) || !valid.test(artifactId)) {
        return null;
    }
    if (version && !/^[A-Za-z0-9_.+-]+$/.test(version)) {
        return null;
    }
    return { groupId, artifactId, version };
}

/**
 * 从 Maven POM 中提取 SCM 仓库地址。
 * 优先 scm.url，其次 connection/developerConnection，最后 project.url（仅 Git 托管）。
 */
export function extractMavenScmRepository(pom: string): string | null {
    const decode = (value: string) => value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();

    const scmBlock = pom.match(/<scm>([\s\S]*?)<\/scm>/i)?.[1] ?? '';
    const candidates: string[] = [];
    for (const tag of ['url', 'connection', 'developerConnection']) {
        const match = scmBlock.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
        if (match?.[1]) {
            candidates.push(decode(match[1]));
        }
    }
    const projectUrl = pom.match(/<url>([\s\S]*?)<\/url>/i)?.[1];
    if (projectUrl) {
        candidates.push(decode(projectUrl));
    }

    for (const candidate of candidates) {
        const normalized = normalizeGitRepositoryUrl(candidate);
        if (normalized) {
            return normalized;
        }
    }
    return null;
}

/**
 * 从 Maven Central 查询完整元数据。
 */
export async function resolveMavenMetadata(
    packageName: string,
    signal?: AbortSignal,
    version?: string
): Promise<PackageMetadata | null> {
    const coordinates = parseMavenCoordinates(packageName);
    if (!coordinates) {
        return null;
    }

    const repositoryUrl = await resolveMavenRepository(packageName, signal, version);
    const resolvedVersion = version || coordinates.version;
    const javadocUrl = resolvedVersion
        ? `https://javadoc.io/doc/${encodeURIComponent(coordinates.groupId)}/${encodeURIComponent(coordinates.artifactId)}/${encodeURIComponent(resolvedVersion)}`
        : `https://javadoc.io/doc/${encodeURIComponent(coordinates.groupId)}/${encodeURIComponent(coordinates.artifactId)}`;

    return {
        source: 'maven',
        libraryId: `${coordinates.groupId}:${coordinates.artifactId}`,
        version: resolvedVersion,
        repositoryUrl,
        documentationUrl: javadocUrl,
        homepageUrl: javadocUrl
    };
}

/**
 * 从 Maven Central 查询 group:artifact 的最新版本，再读取 POM 的 SCM 地址。
 * 版本显式传入时直接读对应 POM，不做 search API 请求。
 */
export async function resolveMavenRepository(
    packageName: string,
    signal?: AbortSignal,
    version?: string
): Promise<string | null> {
    const coordinates = parseMavenCoordinates(packageName);
    if (!coordinates) {
        return null;
    }

    const cleanKey = `${coordinates.groupId}:${coordinates.artifactId}`.toLowerCase();
    const fallbackRepo = (Object.hasOwn(WELL_KNOWN_JAVA_REPOSITORIES, cleanKey)
        ? (WELL_KNOWN_JAVA_REPOSITORIES[cleanKey] ?? null)
        : null)
        || (Object.hasOwn(WELL_KNOWN_JAVA_REPOSITORIES, coordinates.artifactId.toLowerCase())
        ? (WELL_KNOWN_JAVA_REPOSITORIES[coordinates.artifactId.toLowerCase()] ?? null)
        : null);

    if (fallbackRepo) {
        return fallbackRepo;
    }

    let resolvedVersion = version || coordinates.version;
    try {
        if (!resolvedVersion) {
            const searchUrl = `https://search.maven.org/solrsearch/select?q=g:%22${encodeURIComponent(coordinates.groupId)}%22+AND+a:%22${encodeURIComponent(coordinates.artifactId)}%22&rows=1&wt=json`;
            const search = await requestDirectFirst(
                'GET',
                searchUrl,
                (forceDirect) => buildAxiosRequestOptions({
                    timeout: 5000,
                    responseType: 'json',
                    signal,
                    forceDirect
                }),
                'Maven Central search'
            );
            const docs = (search.data as { response?: { docs?: Array<{ latestVersion?: string }> } })?.response?.docs;
            resolvedVersion = docs?.[0]?.latestVersion;
            if (!resolvedVersion) {
                return fallbackRepo;
            }
        }

        const groupPath = coordinates.groupId.split('.').map(encodeURIComponent).join('/');
        const pomUrl = `https://repo1.maven.org/maven2/${groupPath}/${encodeURIComponent(coordinates.artifactId)}/${encodeURIComponent(resolvedVersion)}/${encodeURIComponent(coordinates.artifactId)}-${encodeURIComponent(resolvedVersion)}.pom`;
        const pom = await requestDirectFirst(
            'GET',
            pomUrl,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 5000,
                responseType: 'text',
                signal,
                forceDirect
            }),
            'Maven Central POM'
        );
        if (pom.status !== 200 || typeof pom.data !== 'string') {
            return fallbackRepo;
        }
        return extractMavenScmRepository(pom.data) || fallbackRepo;
    } catch {
        return fallbackRepo;
    }
}

/**
 * 通过 Go module proxy 校验模块并获取元数据。
 */
export async function resolveGoModuleMetadata(packageName: string, signal?: AbortSignal): Promise<PackageMetadata | null> {
    const modulePath = packageName.trim().replace(/^go:/, '').split('@')[0]?.trim();
    if (!modulePath || !modulePath.includes('/') || /\s/.test(modulePath)) {
        return null;
    }

    const encodedModule = modulePath.split('/').map(encodeURIComponent).join('/');
    const url = `https://proxy.golang.org/${encodedModule}/@latest`;
    try {
        const response = await requestDirectFirst(
            'GET',
            url,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 5000,
                responseType: 'json',
                signal,
                forceDirect
            }),
            'Go module proxy'
        );

        if (response.status !== 200 || !response.data) {
            return null;
        }

        let repositoryUrl: string | null = null;
        const lower = modulePath.toLowerCase();
        if (lower.startsWith('github.com/') || lower.startsWith('gitlab.com/')) {
            const [host, owner, repo] = modulePath.split('/');
            if (host && owner && repo) {
                repositoryUrl = `https://${host}/${owner}/${repo}`;
            }
        }

        return {
            source: 'go',
            libraryId: modulePath,
            repositoryUrl,
            documentationUrl: `https://pkg.go.dev/${modulePath}`,
            homepageUrl: `https://pkg.go.dev/${modulePath}`
        };
    } catch {
        return null;
    }
}

/**
 * 通过 Go module proxy 校验模块并推导仓库地址。
 * pkg.go.dev 没有官方 JSON API；这里只承诺 module 元数据兜底 + 可推导的 GitHub/GitLab 仓库 README。
 */
export async function resolveGoModuleRepository(packageName: string, signal?: AbortSignal): Promise<string | null> {
    const meta = await resolveGoModuleMetadata(packageName, signal);
    return meta?.repositoryUrl ?? null;
}

export const CORE_LANGUAGES_AND_TOOLS: Record<string, { repo: string; doc: string; home?: string }> = {
    python: { repo: 'https://github.com/python/cpython', doc: 'https://docs.python.org/3' },
    cpython: { repo: 'https://github.com/python/cpython', doc: 'https://docs.python.org/3' },
    redis: { repo: 'https://github.com/redis/redis', doc: 'https://redis.io/docs' },
    docker: { repo: 'https://github.com/docker/docker-ce', doc: 'https://docs.docker.com' },
    nginx: { repo: 'https://github.com/nginx/nginx', doc: 'https://nginx.org/en/docs' },
    mysql: { repo: 'https://github.com/mysql/mysql-server', doc: 'https://dev.mysql.com/doc' },
    postgres: { repo: 'https://github.com/postgres/postgres', doc: 'https://www.postgresql.org/docs' },
    postgresql: { repo: 'https://github.com/postgres/postgres', doc: 'https://www.postgresql.org/docs' },
    sqlite: { repo: 'https://github.com/sqlite/sqlite', doc: 'https://www.sqlite.org/docs.html' },
    linux: { repo: 'https://github.com/torvalds/linux', doc: 'https://www.kernel.org/doc/html/latest' },
    git: { repo: 'https://github.com/git/git', doc: 'https://git-scm.com/doc' }
};

export const WELL_KNOWN_PYTHON_PACKAGES = new Set([
    'fastapi', 'django', 'flask', 'numpy', 'pandas', 'scipy', 'torch', 'pytorch',
    'tensorflow', 'keras', 'requests', 'urllib3', 'aiohttp', 'sqlalchemy', 'celery',
    'pytest', 'scikit-learn', 'sklearn', 'matplotlib', 'seaborn', 'transformers',
    'huggingface-hub', 'uvicorn', 'gunicorn', 'pydantic', 'alembic', 'scrapy',
    'beautifulsoup4', 'bs4', 'pillow', 'wheel', 'setuptools', 'pip', 'poetry',
    'flit', 'black', 'flake8', 'mypy', 'ruff', 'pylint', 'jupyter', 'ipython',
    'nltk', 'spacy', 'opencv-python', 'xgboost', 'lightgbm', 'optuna', 'ray',
    'dash', 'streamlit', 'gradio', 'fastcore', 'typer', 'click', 'rich', 'httpx',
    'peft', 'accelerate', 'vllm', 'langchain', 'llama-index', 'dbt', 'airflow', 'prefect'
]);

export const WELL_KNOWN_RUST_CRATES = new Set([
    'tokio', 'serde', 'serde_json', 'actix', 'actix-web', 'axum', 'clap', 'diesel',
    'sqlx', 'anyhow', 'thiserror', 'rayon', 'crossbeam', 'futures', 'rand',
    'reqwest', 'hyper', 'tower', 'tracing', 'syn', 'quote', 'proc-macro2',
    'nom', 'regex', 'itertools', 'wasm-bindgen', 'prost', 'tonic'
]);

export const WELL_KNOWN_GO_MODULES = new Set([
    'gin', 'fiber', 'beego', 'echo', 'chi', 'gorm', 'zap', 'logrus', 'viper', 'cobra',
    'testify', 'go-redis'
]);

export const WELL_KNOWN_JAVA_PACKAGES: Record<string, string> = {
    hutool: 'cn.hutool:hutool-all',
    'mybatis-plus': 'com.baomidou:mybatis-plus',
    mybatis: 'org.mybatis:mybatis',
    guava: 'com.google.guava:guava',
    lombok: 'org.projectlombok:lombok',
    fastjson: 'com.alibaba:fastjson',
    fastjson2: 'com.alibaba.fastjson2:fastjson2',
    druid: 'com.alibaba:druid',
    redisson: 'org.redisson:redisson',
    dubbo: 'org.apache.dubbo:dubbo',
    'spring-boot': 'org.springframework.boot:spring-boot',
    'spring-framework': 'org.springframework:spring-core'
};

export const WELL_KNOWN_JAVA_REPOSITORIES: Record<string, string> = {
    hutool: 'https://github.com/dromara/hutool',
    'cn.hutool:hutool-all': 'https://github.com/dromara/hutool',
    'mybatis-plus': 'https://github.com/baomidou/mybatis-plus',
    'com.baomidou:mybatis-plus': 'https://github.com/baomidou/mybatis-plus',
    mybatis: 'https://github.com/mybatis/mybatis-3',
    'org.mybatis:mybatis': 'https://github.com/mybatis/mybatis-3',
    guava: 'https://github.com/google/guava',
    'com.google.guava:guava': 'https://github.com/google/guava',
    lombok: 'https://github.com/projectlombok/lombok',
    'org.projectlombok:lombok': 'https://github.com/projectlombok/lombok',
    fastjson: 'https://github.com/alibaba/fastjson',
    'com.alibaba:fastjson': 'https://github.com/alibaba/fastjson',
    fastjson2: 'https://github.com/alibaba/fastjson2',
    'com.alibaba.fastjson2:fastjson2': 'https://github.com/alibaba/fastjson2',
    druid: 'https://github.com/alibaba/druid',
    'com.alibaba:druid': 'https://github.com/alibaba/druid',
    redisson: 'https://github.com/redisson/redisson',
    'org.redisson:redisson': 'https://github.com/redisson/redisson',
    dubbo: 'https://github.com/apache/dubbo',
    'org.apache.dubbo:dubbo': 'https://github.com/apache/dubbo',
    'spring-boot': 'https://github.com/spring-projects/spring-boot',
    'org.springframework.boot:spring-boot': 'https://github.com/spring-projects/spring-boot',
    'spring-framework': 'https://github.com/spring-projects/spring-framework',
    'org.springframework:spring-core': 'https://github.com/spring-projects/spring-framework'
};

export function isPythonPackageName(name: string): boolean {
    const lower = name.toLowerCase();
    return WELL_KNOWN_PYTHON_PACKAGES.has(lower)
        || lower.startsWith('python-')
        || lower.endsWith('-python')
        || lower.startsWith('py-')
        || lower.startsWith('py_');
}

export function isRustCrateName(name: string): boolean {
    const lower = name.toLowerCase();
    return WELL_KNOWN_RUST_CRATES.has(lower)
        || lower.startsWith('rust-')
        || lower.endsWith('-rs')
        || lower.startsWith('rs_');
}

export function isGoModuleName(name: string): boolean {
    const lower = name.toLowerCase();
    return WELL_KNOWN_GO_MODULES.has(lower)
        || lower.startsWith('go-')
        || lower.endsWith('-go');
}

export function isJavaPackageName(name: string): boolean {
    const lower = name.toLowerCase();
    return Object.hasOwn(WELL_KNOWN_JAVA_PACKAGES, lower)
        || lower.startsWith('java-')
        || lower.endsWith('-java');
}

/**
 * 跨主流包管理器聚合查询元数据（npm -> PyPI -> crates.io -> Go module proxy -> Maven）。
 */
export async function resolvePackageMetadata(
    packageName: string,
    options?: { signal?: AbortSignal; version?: string }
): Promise<PackageMetadata | null> {
    const target = packageName.trim();
    if (!target) return null;

    const lower = target.toLowerCase();
    const core = Object.hasOwn(CORE_LANGUAGES_AND_TOOLS, lower) ? CORE_LANGUAGES_AND_TOOLS[lower] : undefined;
    if (core) {
        return {
            source: 'official' as unknown as PackageMetadata['source'],
            libraryId: target,
            repositoryUrl: core.repo,
            documentationUrl: core.doc,
            homepageUrl: core.home ?? core.doc
        };
    }

    if (target.startsWith('crates:') || target.startsWith('crate:')) {
        return resolveCratesMetadata(target, options?.signal, options?.version);
    }
    if (target.startsWith('pypi:')) {
        return resolvePypiMetadata(target, options?.signal, options?.version);
    }
    if (target.startsWith('npm:')) {
        return resolveNpmMetadata(target, options?.signal, options?.version);
    }
    if (target.startsWith('go:')) {
        return resolveGoModuleMetadata(target, options?.signal);
    }
    if (parseMavenCoordinates(target)) {
        return resolveMavenMetadata(target, options?.signal, options?.version);
    }

    // 生态感知重排序：若包名命中了知名生态，优先查询该生态
    if (isPythonPackageName(lower)) {
        const pypiMeta = await resolvePypiMetadata(target, options?.signal, options?.version);
        if (pypiMeta && (pypiMeta.documentationUrl || pypiMeta.repositoryUrl)) {
            return pypiMeta;
        }
    } else if (isRustCrateName(lower)) {
        const cratesMeta = await resolveCratesMetadata(target, options?.signal, options?.version);
        if (cratesMeta && (cratesMeta.documentationUrl || cratesMeta.repositoryUrl)) {
            return cratesMeta;
        }
    } else if (isGoModuleName(lower)) {
        const goMeta = await resolveGoModuleMetadata(target, options?.signal);
        if (goMeta && goMeta.documentationUrl) {
            return goMeta;
        }
    } else if (isJavaPackageName(lower)) {
        const coords = Object.hasOwn(WELL_KNOWN_JAVA_PACKAGES, lower) ? WELL_KNOWN_JAVA_PACKAGES[lower] : undefined;
        if (coords) {
            const mavenMeta = await resolveMavenMetadata(coords, options?.signal, options?.version);
            if (mavenMeta && (mavenMeta.documentationUrl || mavenMeta.repositoryUrl)) {
                return mavenMeta;
            }
        }
        // Java 知名包（如 hutool）未在 Maven 找到时，禁止回退到 npm/PyPI 抢注包
        return null;
    }

    const npmMeta = await resolveNpmMetadata(target, options?.signal, options?.version);
    if (npmMeta && (npmMeta.documentationUrl || npmMeta.repositoryUrl)) {
        return npmMeta;
    }

    const pypiMeta = await resolvePypiMetadata(target, options?.signal, options?.version);
    if (pypiMeta && (pypiMeta.documentationUrl || pypiMeta.repositoryUrl)) {
        return pypiMeta;
    }

    const cratesMeta = await resolveCratesMetadata(target, options?.signal, options?.version);
    if (cratesMeta && (cratesMeta.documentationUrl || cratesMeta.repositoryUrl)) {
        return cratesMeta;
    }

    const goMeta = await resolveGoModuleMetadata(target, options?.signal);
    if (goMeta && goMeta.documentationUrl) {
        return goMeta;
    }

    return null;
}

/**
 * 当 Context7 命中低置信度或不存在时，依次向 npm、PyPI、crates.io、Go module proxy 兜底，
 * 通过提取到的 Git 仓库直接抓取官方 README。
 */
export async function fetchPackageDocsFallback(options: {
    library: string;
    version?: string;
    signal?: AbortSignal;
    fetchGithub: (url: string) => Promise<string | null>;
    reasonHint?: string;
}): Promise<PackageDocsFallbackResult | null> {
    const rawTarget = options.library.trim();
    const version = options.version?.trim() || undefined;
    // 剔除前后斜杠（如果是 Context7 库名形式如 /owner/repo，直接提取 repo）
    const cleanTarget = rawTarget.startsWith('/')
        ? rawTarget.replace(/^\/+/, '').split('/')[1] || rawTarget.replace(/^\/+/, '')
        : rawTarget;
    const displayTarget = version ? `${cleanTarget}@${version}` : cleanTarget;
    const lowerClean = cleanTarget.toLowerCase();

    const buildWarning = (registryName: string, repoUrl: string): string[] => {
        if (options.reasonHint === '') {
            return [];
        }
        const reason = options.reasonHint ?? 'Context7 match confidence was low or library was not found in Context7.';
        const suffix = version ? ` (requested version ${version})` : '';
        return [`${reason} Fallback to ${registryName} package repository (${repoUrl}) README${suffix}.`];
    };

    // 0. 核心语言/工具直通（如 python, redis, docker, nginx 等）
    const core = Object.hasOwn(CORE_LANGUAGES_AND_TOOLS, lowerClean) ? CORE_LANGUAGES_AND_TOOLS[lowerClean] : undefined;
    if (core) {
        const readme = await options.fetchGithub(core.repo);
        if (readme && readme.trim().length > 20) {
            return {
                source: 'github-readme',
                confidence: 'high',
                libraryId: displayTarget,
                repositoryUrl: core.repo,
                readme: readme.trim(),
                documentationUrl: core.doc,
                warnings: buildWarning('official repository', core.repo)
            };
        }
    }

    const hasExplicitPrefix = /^(?:npm|pypi|crates?|go|maven):/i.test(rawTarget);
    const preferPython = isPythonPackageName(lowerClean) || rawTarget.startsWith('pypi:');
    const preferRust = isRustCrateName(lowerClean) || rawTarget.startsWith('crate:') || rawTarget.startsWith('crates:');
    const preferGo = isGoModuleName(lowerClean) || rawTarget.startsWith('go:');
    const preferJava = isJavaPackageName(lowerClean) || rawTarget.startsWith('maven:') || rawTarget.startsWith('javadoc:');
    const defaultConfidence: 'high' | 'medium' = hasExplicitPrefix ? 'high' : 'medium';

    const buildEcosystemWarning = (registry: string, repo: string): string[] => {
        if (options.reasonHint === '') {
            return [];
        }
        const base = buildWarning(registry, repo);
        if (!hasExplicitPrefix) {
            base.push(`Package "${cleanTarget}" was resolved in ${registry}. If you intended another ecosystem (such as npm, PyPI, crates.io, or Go), specify with prefix (e.g. "pypi:${cleanTarget}").`);
        }
        return base;
    };

    // 如果优先 Java 生态（如 hutool, mybatis-plus, guava 等）
    if (preferJava) {
        try {
            const coords = (Object.hasOwn(WELL_KNOWN_JAVA_PACKAGES, lowerClean) ? WELL_KNOWN_JAVA_PACKAGES[lowerClean] : cleanTarget) ?? cleanTarget;
            const mavenRepo = (Object.hasOwn(WELL_KNOWN_JAVA_REPOSITORIES, lowerClean) ? WELL_KNOWN_JAVA_REPOSITORIES[lowerClean] : null)
                || await resolveMavenRepository(coords, options.signal, version)
                || (Object.hasOwn(WELL_KNOWN_JAVA_REPOSITORIES, coords.toLowerCase()) ? WELL_KNOWN_JAVA_REPOSITORIES[coords.toLowerCase()] : null);
            if (mavenRepo) {
                const readme = await options.fetchGithub(mavenRepo);
                if (readme && readme.trim().length > 20) {
                    return {
                        source: 'maven',
                        confidence: hasExplicitPrefix || Object.hasOwn(WELL_KNOWN_JAVA_PACKAGES, lowerClean) ? 'high' : defaultConfidence,
                        libraryId: displayTarget,
                        repositoryUrl: mavenRepo,
                        readme: readme.trim(),
                        warnings: buildEcosystemWarning('Maven Central', mavenRepo)
                    };
                }
            }
        } catch {
            // 继续向下尝试其他源
        }
    }

    if (preferJava) {
        // Java 包（如 hutool、guava、或 java-* 等）未在 Maven 提取到 README 时，严禁向 npm / PyPI 兜底，防止命中 pypa 抢注垃圾包
        return null;
    }

    // 1. 如果优先 Python 生态（如 fastapi, django, pytest 等）
    if (preferPython) {
        try {
            const pypiRepo = await resolvePypiRepository(cleanTarget, options.signal, version);
            if (pypiRepo) {
                const readme = await options.fetchGithub(pypiRepo);
                if (readme && readme.trim().length > 50) {
                    return {
                        source: 'pypi',
                        confidence: hasExplicitPrefix || WELL_KNOWN_PYTHON_PACKAGES.has(lowerClean) ? 'high' : defaultConfidence,
                        libraryId: displayTarget,
                        repositoryUrl: pypiRepo,
                        readme: readme.trim(),
                        warnings: buildEcosystemWarning('PyPI', pypiRepo)
                    };
                }
            }
        } catch {
            // 继续向下尝试其他源
        }
    }

    // 2. 如果优先 Rust 生态
    if (preferRust) {
        try {
            const cratesRepo = await resolveCratesRepository(cleanTarget, options.signal);
            if (cratesRepo) {
                const readme = await options.fetchGithub(cratesRepo);
                if (readme && readme.trim().length > 50) {
                    return {
                        source: 'crates',
                        confidence: hasExplicitPrefix || WELL_KNOWN_RUST_CRATES.has(lowerClean) ? 'high' : defaultConfidence,
                        libraryId: displayTarget,
                        repositoryUrl: cratesRepo,
                        readme: readme.trim(),
                        warnings: buildEcosystemWarning('crates.io', cratesRepo)
                    };
                }
            }
        } catch {
            // 继续向下尝试其他源
        }
    }

    // 3. 如果优先 Go 生态
    if (preferGo) {
        try {
            const goRepo = await resolveGoModuleRepository(cleanTarget, options.signal);
            if (goRepo) {
                const readme = await options.fetchGithub(goRepo);
                if (readme && readme.trim().length > 50) {
                    return {
                        source: 'go',
                        confidence: hasExplicitPrefix || WELL_KNOWN_GO_MODULES.has(lowerClean) ? 'high' : defaultConfidence,
                        libraryId: displayTarget,
                        repositoryUrl: goRepo,
                        readme: readme.trim(),
                        warnings: buildEcosystemWarning('Go module proxy', goRepo)
                    };
                }
            }
        } catch {
            // 继续向下尝试其他源
        }
    }

    // 4. 常规回退链：npm 注册表
    try {
        const npmRepo = await resolveNpmRepository(cleanTarget, options.signal, version);
        if (npmRepo) {
            const readme = await options.fetchGithub(npmRepo);
            if (readme && readme.trim().length > 50) {
                return {
                    source: 'npm',
                    confidence: hasExplicitPrefix ? 'high' : 'medium',
                    libraryId: displayTarget,
                    repositoryUrl: npmRepo,
                    readme: readme.trim(),
                    warnings: buildEcosystemWarning('npm', npmRepo)
                };
            }
        }
    } catch {
        // npm fallback failed, continue to PyPI
    }

    // 5. 常规回退链：PyPI（若前置未命中）
    if (!preferPython) {
        try {
            const pypiRepo = await resolvePypiRepository(cleanTarget, options.signal, version);
            if (pypiRepo) {
                const readme = await options.fetchGithub(pypiRepo);
                if (readme && readme.trim().length > 50) {
                    return {
                        source: 'pypi',
                        confidence: defaultConfidence,
                        libraryId: displayTarget,
                        repositoryUrl: pypiRepo,
                        readme: readme.trim(),
                        warnings: buildEcosystemWarning('PyPI', pypiRepo)
                    };
                }
            }
        } catch {
            // PyPI fallback failed
        }
    }

    // 6. 常规回退链：crates.io（Rust）
    if (!preferRust) {
        try {
            const cratesRepo = await resolveCratesRepository(cleanTarget, options.signal);
            if (cratesRepo) {
                const readme = await options.fetchGithub(cratesRepo);
                if (readme && readme.trim().length > 50) {
                    return {
                        source: 'crates',
                        confidence: defaultConfidence,
                        libraryId: displayTarget,
                        repositoryUrl: cratesRepo,
                        readme: readme.trim(),
                        warnings: buildEcosystemWarning('crates.io', cratesRepo)
                    };
                }
            }
        } catch {
            // crates.io fallback failed
        }
    }

    // 7. 常规回退链：Go module proxy
    if (!preferGo) {
        try {
            const goRepo = await resolveGoModuleRepository(cleanTarget, options.signal);
            if (goRepo) {
                const readme = await options.fetchGithub(goRepo);
                if (readme && readme.trim().length > 50) {
                    return {
                        source: 'go',
                        confidence: defaultConfidence,
                        libraryId: displayTarget,
                        repositoryUrl: goRepo,
                        readme: readme.trim(),
                        warnings: buildEcosystemWarning('Go module proxy', goRepo)
                    };
                }
            }
        } catch {
            // Go module fallback failed
        }
    }

    // 8. 常规回退链：Maven Central（Java/Kotlin/Scala）
    try {
        const mavenRepo = await resolveMavenRepository(cleanTarget, options.signal, version);
        if (mavenRepo) {
            const readme = await options.fetchGithub(mavenRepo);
            if (readme && readme.trim().length > 50) {
                return {
                    source: 'maven',
                    confidence: defaultConfidence,
                    libraryId: displayTarget,
                    repositoryUrl: mavenRepo,
                    readme: readme.trim(),
                    warnings: buildEcosystemWarning('Maven Central', mavenRepo)
                };
            }
        }
    } catch {
        // Maven Central fallback failed
    }

    return null;
}
