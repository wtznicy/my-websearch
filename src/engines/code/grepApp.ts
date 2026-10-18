import { SearchResult } from '../../types.js';
import { AppError } from '../../core/errors.js';
import { requestDirectFirst, buildAxiosRequestOptions } from '../../utils/httpRequest.js';
import { DEFAULT_DESKTOP_UA } from '../../utils/userAgents.js';

interface GrepAppHit {
    repo?: { raw?: string };
    path?: { raw?: string };
    content?: { snippet?: string };
    line?: { raw?: number };
}

interface GrepAppResponse {
    hits?: {
        total?: number;
        hits?: GrepAppHit[];
    };
    facets?: unknown;
}

export async function searchGrepApp(
    query: string,
    limit = 10,
    context?: { signal?: AbortSignal }
): Promise<SearchResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
        return [];
    }

    const apiUrl = `https://grep.app/api/search?q=${encodeURIComponent(cleanQuery)}`;
    const headers: Record<string, string> = {
        'User-Agent': DEFAULT_DESKTOP_UA,
        'Accept': 'application/json',
        'Referer': 'https://grep.app/'
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any;
    try {
        response = await requestDirectFirst('GET', apiUrl, (forceDirect) => ({
            ...buildAxiosRequestOptions({
                headers,
                forceDirect,
                signal: context?.signal,
                timeout: 8000
            }),
            responseType: 'json',
            validateStatus: (status: number) => status >= 200 && status < 500
        }), 'grep.app code search');
    } catch (err) {
        if (context?.signal?.aborted) {
            throw err;
        }
        throw new AppError({
            code: 'network_error',
            engine: 'code',
            message: `grep.app request failed: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true
        });
    }

    if (response.status === 429) {
        throw new AppError({
            code: 'rate_limited',
            engine: 'code',
            message: 'grep.app code search rate limited (HTTP 429)',
            retryable: true
        });
    }

    if (response.status >= 400) {
        throw new AppError({
            code: 'engine_error',
            engine: 'code',
            message: `grep.app returned HTTP ${response.status}`,
            retryable: response.status >= 500
        });
    }

    return parseGrepAppResponse(response.data, limit);
}

export function parseGrepAppResponse(data: GrepAppResponse | string | unknown, limit = 10): SearchResult[] {
    if (typeof data === 'string') {
        if (data.includes('Security Checkpoint') || data.includes('cf-browser-verification')) {
            throw new AppError({
                code: 'bot_challenge',
                engine: 'code',
                message: 'grep.app triggered security checkpoint',
                retryable: true
            });
        }
        return [];
    }

    const typedData = data as GrepAppResponse;
    const hits = typedData?.hits?.hits;
    if (!Array.isArray(hits) || hits.length === 0) {
        return [];
    }

    const results: SearchResult[] = [];
    for (const hit of hits.slice(0, limit)) {
        const repo = hit.repo?.raw || 'unknown';
        const filePath = hit.path?.raw || '';
        const line = hit.line?.raw;
        const lineAnchor = typeof line === 'number' ? `#L${line}` : '';
        const url = `https://github.com/${repo}/blob/master/${filePath}${lineAnchor}`;
        const title = `${repo}: ${filePath}${lineAnchor}`;

        let snippet = (hit.content?.snippet || '').trim();
        snippet = snippet.replace(/<mark>/gi, '').replace(/<\/mark>/gi, '');

        results.push({
            title,
            url,
            description: snippet || `Code match in ${repo} at ${filePath}`,
            source: repo,
            engine: 'code',
            repo,
            path: filePath,
            line
        });
    }

    return results;
}
