import type { SearchResult } from '../types.js';

export interface SearchOperators {
    /** Query with recognized operators removed. */
    text: string;
    siteDomains: string[];
    fileTypes: string[];
    after?: string;
    before?: string;
    excludedTerms: string[];
}

const OPERATOR_PATTERN = /(?:^|\s)(site|filetype|after|before):(?:"([^"]+)"|(\S+))/gi;
const EXCLUDED_PATTERN = /(?:^|\s)-("([^"]+)"|(\S+))/g;

function normalizeSite(value: string): string | null {
    let candidate = value.trim().toLowerCase();
    if (!candidate) return null;
    candidate = candidate.replace(/^https?:\/\//, '').replace(/^\/\//, '');
    candidate = candidate.split('/')[0]?.split('?')[0]?.split('#')[0] ?? '';
    candidate = candidate.replace(/^www\./, '').replace(/:\d+$/, '');
    if (!candidate || !/^[a-z0-9.-]+$/.test(candidate)) return null;
    return candidate;
}

function normalizeFileType(value: string): string | null {
    const cleaned = value.trim().toLowerCase().replace(/^\./, '');
    return /^[a-z0-9]+$/.test(cleaned) ? cleaned : null;
}

function normalizeDate(value: string): string | undefined {
    const match = value.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
    if (!match) return undefined;
    const [, year, month, day] = match;
    const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return undefined;
    return `${year}-${month}-${day}`;
}

/**
 * Parse standard search operators without destroying the free-text query.
 * Unknown or malformed operators are left in the text so engines can still see them.
 */
export function parseSearchOperators(raw: string): SearchOperators {
    const siteDomains = new Set<string>();
    const fileTypes = new Set<string>();
    const excludedTerms = new Set<string>();
    let after: string | undefined;
    let before: string | undefined;

    const withoutOperators = raw.replace(OPERATOR_PATTERN, (_whole, operator: string, quoted?: string, bare?: string) => {
        const value = (quoted ?? bare ?? '').trim();
        if (operator.toLowerCase() === 'site') {
            const site = normalizeSite(value);
            if (site) {
                siteDomains.add(site);
                return ' ';
            }
        } else if (operator.toLowerCase() === 'filetype') {
            const type = normalizeFileType(value);
            if (type) {
                fileTypes.add(type);
                return ' ';
            }
        } else if (operator.toLowerCase() === 'after') {
            const date = normalizeDate(value);
            if (date) {
                after = date;
                return ' ';
            }
        } else if (operator.toLowerCase() === 'before') {
            const date = normalizeDate(value);
            if (date) {
                before = date;
                return ' ';
            }
        }
        return _whole;
    });

    const text = withoutOperators.replace(EXCLUDED_PATTERN, (_whole, quoted?: string, bare?: string) => {
        const term = (quoted ?? bare ?? '').replace(/^"|"$/g, '').trim();
        if (term.length >= 2) {
            excludedTerms.add(term.toLowerCase());
            return ' ';
        }
        return _whole;
    }).replace(/\s{2,}/g, ' ').trim();

    return {
        text: text || raw.trim(),
        siteDomains: [...siteDomains],
        fileTypes: [...fileTypes],
        after,
        before,
        excludedTerms: [...excludedTerms]
    };
}

/** Rebuild an engine-facing query. Native engines get site/filetype; API engines get plain text. */
export function buildEngineQuery(
    operators: SearchOperators,
    supportsNativeSite: boolean
): string {
    if (!supportsNativeSite) {
        return operators.text;
    }
    let query = operators.text;
    if (operators.siteDomains.length > 0) {
        query += ` ${operators.siteDomains.map((site) => `site:${site}`).join(' ')}`;
    }
    if (operators.fileTypes.length > 0) {
        query += ` ${operators.fileTypes.map((type) => `filetype:${type}`).join(' ')}`;
    }
    return query.trim();
}

function hostMatches(host: string, domain: string): boolean {
    return host === domain || host.endsWith(`.${domain}`);
}

function fileTypeMatches(result: SearchResult, fileTypes: string[]): boolean {
    if (fileTypes.length === 0) return true;
    let pathname = '';
    try {
        pathname = new URL(result.url).pathname.toLowerCase();
    } catch {
        pathname = result.url.toLowerCase();
    }
    return fileTypes.some((type) => {
        if (type === 'html' || type === 'htm') {
            // Most HTML pages have no .html suffix; reject only obvious non-HTML assets.
            return !/\.(pdf|docx?|xlsx?|pptx?|zip|tar|gz|png|jpe?g|gif|svg|mp4|mp3)$/i.test(pathname);
        }
        return pathname.endsWith(`.${type}`);
    });
}

/** Apply operators that the engines may have ignored. Unknown dates are kept. */
export function matchesSearchOperators(result: SearchResult, operators: SearchOperators): boolean {
    if (operators.siteDomains.length > 0) {
        let host = '';
        try {
            host = new URL(result.url).hostname.toLowerCase().replace(/^www\./, '');
        } catch {
            return false;
        }
        if (!operators.siteDomains.some((domain) => hostMatches(host, domain))) {
            return false;
        }
    }

    if (!fileTypeMatches(result, operators.fileTypes)) {
        return false;
    }

    if (operators.excludedTerms.length > 0) {
        const haystack = `${result.title} ${result.description} ${result.url}`.toLowerCase();
        if (operators.excludedTerms.some((term) => haystack.includes(term))) {
            return false;
        }
    }

    if (operators.after || operators.before) {
        const published = result.publishedAt;
        if (published) {
            if (operators.after && published < operators.after) return false;
            if (operators.before && published > operators.before) return false;
        }
    }

    return true;
}
