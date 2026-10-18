export type TimeRange = 'day' | 'week' | 'month' | 'year';

export function normalizePublishedDate(rawDate?: string, referenceNow = new Date()): string | undefined {
    if (!rawDate || !rawDate.trim()) {
        return undefined;
    }

    const trimmed = rawDate.trim();

    // 1. Check ISO or YYYY-MM-DD format
    const isoMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
        const year = isoMatch[1];
        const month = isoMatch[2].padStart(2, '0');
        const day = isoMatch[3].padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // 2. Check YYYY年MM月DD日
    const cnDateMatch = trimmed.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?/);
    if (cnDateMatch && cnDateMatch[1] && cnDateMatch[2] && cnDateMatch[3]) {
        const year = cnDateMatch[1];
        const month = cnDateMatch[2].padStart(2, '0');
        const day = cnDateMatch[3].padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // 3. Relative time parsing (e.g. 5分钟前, 2小时前, 3天前, 1周前, 2个月前, 1年前, 昨天, 前天)
    const now = referenceNow;
    if (/刚刚|半小时前|分钟前|小时前|hours?\s+ago|mins?\s+ago|minutes?\s+ago/i.test(trimmed)) {
        return formatDateIso(now);
    }
    if (/昨天|yesterday/i.test(trimmed)) {
        const d = new Date(now.getTime() - 24 * 3600 * 1000);
        return formatDateIso(d);
    }
    if (/前天/i.test(trimmed)) {
        const d = new Date(now.getTime() - 48 * 3600 * 1000);
        return formatDateIso(d);
    }

    const daysMatch = trimmed.match(/(\d+)\s*(?:天前|days?\s+ago)/i);
    if (daysMatch && daysMatch[1]) {
        const days = Number(daysMatch[1]);
        const d = new Date(now.getTime() - days * 24 * 3600 * 1000);
        return formatDateIso(d);
    }

    const weeksMatch = trimmed.match(/(\d+)\s*(?:周前|星期前|weeks?\s+ago)/i);
    if (weeksMatch && weeksMatch[1]) {
        const weeks = Number(weeksMatch[1]);
        const d = new Date(now.getTime() - weeks * 7 * 24 * 3600 * 1000);
        return formatDateIso(d);
    }

    const monthsMatch = trimmed.match(/(\d+)\s*(?:个月前|月前|months?\s+ago)/i);
    if (monthsMatch && monthsMatch[1]) {
        const months = Number(monthsMatch[1]);
        const d = new Date(now.getTime() - months * 30 * 24 * 3600 * 1000);
        return formatDateIso(d);
    }

    const yearsMatch = trimmed.match(/(\d+)\s*(?:年前|years?\s+ago)/i);
    if (yearsMatch && yearsMatch[1]) {
        const years = Number(yearsMatch[1]);
        const d = new Date(now.getTime() - years * 365 * 24 * 3600 * 1000);
        return formatDateIso(d);
    }

    // 4. Try generic Date.parse for formats like "Oct 17, 2026"
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
        return formatDateIso(new Date(parsed));
    }

    return undefined;
}

export const normalizeDateToIso = normalizePublishedDate;

function formatDateIso(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function getTimeRangeCutoffDate(range: TimeRange, now = new Date()): Date {
    const time = now.getTime();
    switch (range) {
        case 'day':
            return new Date(time - 24 * 3600 * 1000);
        case 'week':
            return new Date(time - 7 * 24 * 3600 * 1000);
        case 'month':
            return new Date(time - 31 * 24 * 3600 * 1000);
        case 'year':
            return new Date(time - 365 * 24 * 3600 * 1000);
    }
}

export function isDateWithinTimeRange(publishedAt: string | undefined, range: TimeRange, now = new Date()): boolean {
    if (!publishedAt) {
        return false;
    }
    let parsed = Date.parse(publishedAt);
    if (Number.isNaN(parsed)) {
        return false;
    }
    // If publishedAt is date-only (e.g. YYYY-MM-DD), count through end of that day UTC
    if (/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) {
        parsed += 24 * 3600 * 1000 - 1;
    }
    const cutoff = getTimeRangeCutoffDate(range, now).getTime();
    return parsed >= cutoff;
}
