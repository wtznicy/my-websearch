/**
 * Javadoc.io 官方 Java/Maven 生态文档检索器。
 *
 * 规范：
 * - 格式：groupId:artifactId 或 带版本 groupId:artifactId@version
 * - 前缀支持：javadoc:org.springframework:spring-core 或 maven:com.google.guava:guava
 * - 官方文档直连：https://javadoc.io/doc/<groupId>/<artifactId>/<version|latest>/index.html
 */

import { parseMavenCoordinates } from './packageDocsFallback.js';
import { logTool } from '../../tools/toolShared.js';

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

/** 判断目标是否适合作为 Javadoc 查询 */
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
    signal?: AbortSignal;
    fetchWeb: (url: string) => Promise<string | null>;
}): Promise<JavadocResult | null> {
    const rawTarget = options.library.trim().replace(/^(?:javadoc|maven):/i, '').trim();
    const parsed = parseMavenCoordinates(rawTarget);
    if (!parsed) {
        return null;
    }

    const version = options.version?.trim() || parsed.version || 'latest';
    const docUrl = `${JAVADOC_BASE}/${parsed.groupId}/${parsed.artifactId}/${encodeURIComponent(version)}/index.html`;

    logTool(`Querying Javadoc.io: ${docUrl}`);
    const content = await options.fetchWeb(docUrl);
    if (!content || content.trim().length < 20) {
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
        documentationUrl: `https://javadoc.io/doc/${parsed.groupId}/${parsed.artifactId}/${version}`,
        content: content.trim()
    };
}
