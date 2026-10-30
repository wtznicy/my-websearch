import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGlobalPageCache } from '../core/fetch/pageCache.js';
import { getDocsCache, listDocsCache } from '../core/docs/docsCache.js';

const MAX_RESOURCE_CHARS = 200_000;

function truncate(text: string): string {
    if (text.length <= MAX_RESOURCE_CHARS) return text;
    return `${text.slice(0, MAX_RESOURCE_CHARS)}\n\n[truncated at ${MAX_RESOURCE_CHARS} characters]`;
}

/**
 * Read-only MCP resources over the existing page/docs caches.
 *
 * Security boundary: a resource can only read an entry that was already cached by
 * fetchWebContent/queryDocs. It never triggers a network fetch or accepts an arbitrary URL.
 */
export function registerResources(server: McpServer): void {
    server.registerResource(
        'websearch-page-cache',
        'websearch://cache/pages',
        {
            title: 'Web page cache index',
            description: 'Recently cached pages from fetchWebContent (metadata only).',
            mimeType: 'application/json'
        },
        async (uri) => {
            const entries = getGlobalPageCache().list(50).map((record) => ({
                id: record.urlHash,
                url: record.normalizedUrl,
                title: record.title,
                format: record.format,
                chars: record.markdown.length,
                fetchedAt: new Date(record.fetchedAt).toISOString(),
                expiresAt: new Date(record.expiresAt).toISOString()
            }));
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify({ entries }, null, 2)
                }]
            };
        }
    );

    server.registerResource(
        'websearch-page',
        new ResourceTemplate('websearch://cache/pages/{id}', { list: undefined }),
        {
            title: 'Cached web page',
            description: 'Full Markdown of a cached fetchWebContent page, by cache id.',
            mimeType: 'text/markdown'
        },
        async (uri, variables) => {
            const rawId = Array.isArray(variables.id) ? variables.id[0] : variables.id;
            const id = decodeURIComponent(rawId ?? '');
            const record = getGlobalPageCache().getByHash(id);
            if (!record) {
                throw new Error(`No cached page found for id "${id}". Read websearch://cache/pages for ids.`);
            }
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/markdown',
                    text: truncate(record.markdown)
                }]
            };
        }
    );

    server.registerResource(
        'websearch-docs-cache',
        'websearch://cache/docs',
        {
            title: 'Docs cache index',
            description: 'Recently cached queryDocs results (metadata only).',
            mimeType: 'application/json'
        },
        async (uri) => {
            const entries = listDocsCache(50).map((entry) => ({
                id: encodeURIComponent(entry.key),
                source: entry.value.source,
                confidence: entry.value.confidence,
                chars: entry.value.text.length,
                cachedAt: new Date(entry.value.cachedAt).toISOString(),
                expiresAt: new Date(entry.expiresAt).toISOString()
            }));
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify({ entries }, null, 2)
                }]
            };
        }
    );

    server.registerResource(
        'websearch-docs',
        new ResourceTemplate('websearch://cache/docs/{id}', { list: undefined }),
        {
            title: 'Cached docs result',
            description: 'Full cached queryDocs Markdown, by cache id.',
            mimeType: 'text/markdown'
        },
        async (uri, variables) => {
            const rawId = Array.isArray(variables.id) ? variables.id[0] : variables.id;
            const key = decodeURIComponent(rawId ?? '');
            const entry = getDocsCache(key);
            if (!entry) {
                throw new Error(`No cached docs result found for id "${key}". Read websearch://cache/docs for ids.`);
            }
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/markdown',
                    text: truncate(entry.text)
                }]
            };
        }
    );
}
