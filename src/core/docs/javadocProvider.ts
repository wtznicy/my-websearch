/**
 * Javadoc.io 官方 Java/Maven 生态文档检索器。
 *
 * 规范：
 * - 格式：groupId:artifactId 或 带版本 groupId:artifactId@version
 * - 前缀支持：javadoc:org.springframework:spring-core 或 maven:com.google.guava:guava
 * - 官方文档直连：https://javadoc.io/doc/<groupId>/<artifactId>/<version|latest>/index.html
 */

import { parseMavenCoordinates, WELL_KNOWN_JAVA_PACKAGES } from './packageDocsFallback.js';
import { logTool } from '../../tools/toolShared.js';
import { requestDirectFirst, buildAxiosRequestOptions } from '../../utils/httpRequest.js';

export interface JavadocResult {
    source: 'javadoc';
    libraryId: string;
    documentationUrl: string;
    content: string;
    groupId: string;
    artifactId: string;
    version?: string;
}

const JAVADOC_BASE = 'https://javadoc.io/doc';

/** 判断目标是否适合作为 Javadoc 快速路由（仅限显式前缀或标准 Maven 坐标） */
export function isLikelyJavadocTarget(target: string): boolean {
    const clean = target.trim().toLowerCase();
    if (clean.startsWith('javadoc:') || clean.startsWith('maven:')) {
        return true;
    }
    return parseMavenCoordinates(clean) !== null;
}

/** 核心入口：检索并拉取 Javadoc.io Markdown 文档 */
export async function queryJavadocDocs(options: {
    library: string;
    version?: string;
    query?: string;
    signal?: AbortSignal;
    fetchWeb: (url: string) => Promise<string | null>;
}): Promise<JavadocResult | null> {
    const rawTarget = options.library.trim().replace(/^(?:javadoc|maven):/i, '').trim();
    const lower = rawTarget.toLowerCase();
    const coords = (Object.hasOwn(WELL_KNOWN_JAVA_PACKAGES, lower)
        ? WELL_KNOWN_JAVA_PACKAGES[lower]
        : rawTarget) ?? rawTarget;
    const parsed = parseMavenCoordinates(coords);
    if (!parsed) {
        return null;
    }

    const version = options.version?.trim() || parsed.version || 'latest';
    const wrapperUrl = `${JAVADOC_BASE}/${parsed.groupId}/${parsed.artifactId}/${encodeURIComponent(version)}/index.html`;

    let targetDocUrl = wrapperUrl;
    let staticBase: string | null = null;

    // 探测 Javadoc.io 包装页中的实际静态资源目录（/static/<groupId>/<artifactId>/<version>）
    try {
        const resp = await requestDirectFirst(
            'GET',
            wrapperUrl,
            (forceDirect) => buildAxiosRequestOptions({
                timeout: 5000,
                signal: options.signal,
                forceDirect
            }),
            `Javadoc wrapper for ${parsed.groupId}:${parsed.artifactId}`
        );
        if (resp.status === 200 && typeof resp.data === 'string') {
            const iframeMatch = resp.data.match(/<iframe[^>]+src="(\/static\/[^"]+)"/i);
            if (iframeMatch?.[1]) {
                staticBase = `https://javadoc.io${iframeMatch[1].replace(/\/[^/]+$/, '')}`;
                targetDocUrl = `${staticBase}/index.html`;
            }
        }
    } catch {
        // 请求包装页异常时继续使用默认 wrapperUrl
    }

    // 若带有具体类名/方法 query，尝试定位到具体的类文档（如 ImmutableList -> com/google/common/collect/ImmutableList.html）
    const cleanQuery = (options.query ?? '').trim().replace(/[()[\]{}#]/g, ' ').split(/\s+/)[0]?.trim();
    if (staticBase && cleanQuery && /^[A-Za-z0-9_$.]+$/.test(cleanQuery)) {
        if (cleanQuery.includes('.')) {
            const directClassUrl = `${staticBase}/${cleanQuery.replace(/\./g, '/')}.html`;
            const testContent = await options.fetchWeb(directClassUrl);
            if (testContent && testContent.trim().length > 100) {
                targetDocUrl = directClassUrl;
            }
        } else {
            try {
                const searchResp = await requestDirectFirst(
                    'GET',
                    `${staticBase}/type-search-index.js`,
                    (forceDirect) => buildAxiosRequestOptions({
                        timeout: 5000,
                        signal: options.signal,
                        forceDirect
                    }),
                    `Javadoc type-search-index for ${parsed.artifactId}`
                );
                if (searchResp.status === 200 && typeof searchResp.data === 'string') {
                    const match = searchResp.data.match(new RegExp(`{"p":"([^"]+)","l":"${cleanQuery}"}`, 'i'));
                    if (match?.[1]) {
                        const packagePath = match[1].replace(/\./g, '/');
                        targetDocUrl = `${staticBase}/${packagePath}/${cleanQuery}.html`;
                    }
                }
            } catch {
                // type-search-index 探测失败（例如 JDK 8 Javadoc），继续使用 targetDocUrl
            }
        }
    }

    logTool(`Querying Javadoc.io: ${targetDocUrl}`);
    const content = await options.fetchWeb(targetDocUrl);
    if (!content || content.trim().length < 20) {
        return null;
    }

    // 识别 Javadoc.io 包装导航壳（仅含 "Latest version of..." 及版本导航链接，无具体文档正文）
    const isNavigationWrapper = content.includes('Latest version of')
        && !content.includes('Class ')
        && !content.includes('Interface ')
        && !content.includes('Package ');
    if (isNavigationWrapper) {
        logTool(`Javadoc.io returned navigation wrapper stub without documentation body for ${parsed.groupId}:${parsed.artifactId}`);
        return null;
    }

    // 识别 Javadoc 框架预警 / 禁用提示（静态 index.html 通常为 noscript 框架警告页）
    if (/Frame Alert|框架预警|JavaScript is disabled|您的浏览器已禁用/.test(content)) {
        logTool(`Javadoc.io returned frame warning/index page without class body for ${parsed.groupId}:${parsed.artifactId}`);
        return null;
    }

    // 若调用方带有具体类/方法 query，但最终未能定位到具体类页（仍落在根 index.html 或包装页），返回 null 让上层继续兜底
    if (cleanQuery && (targetDocUrl.endsWith('/index.html') || targetDocUrl === wrapperUrl)) {
        logTool(`Javadoc.io could not locate specific class documentation for query "${options.query}" in ${parsed.groupId}:${parsed.artifactId}`);
        return null;
    }

    const displayId = version && version !== 'latest'
        ? `${parsed.groupId}:${parsed.artifactId}@${version}`
        : `${parsed.groupId}:${parsed.artifactId}`;

    return {
        source: 'javadoc',
        libraryId: displayId,
        groupId: parsed.groupId,
        artifactId: parsed.artifactId,
        version: version !== 'latest' ? version : undefined,
        documentationUrl: targetDocUrl,
        content: content.trim()
    };
}
