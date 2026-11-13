export type TimeRange = 'day' | 'week' | 'month' | 'year';

const ENGLISH_MONTHS: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
};

export function parseEnglishDate(str: string): string | undefined {
    // e.g. "Oct 17, 2026", "October 17 2026", "17 Oct 2026", "17th October, 2026"
    const m1 = str.match(/\b([a-zA-Z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/i);
    if (m1 && m1[1] && m1[2] && m1[3]) {
        const monthNum = ENGLISH_MONTHS[m1[1].toLowerCase()];
        if (monthNum) {
            const year = m1[3];
            const month = String(monthNum).padStart(2, '0');
            const day = String(Number(m1[2])).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
    }

    const m2 = str.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]{3,9}),?\s+((?:19|20)\d{2})\b/i);
    if (m2 && m2[1] && m2[2] && m2[3]) {
        const monthNum = ENGLISH_MONTHS[m2[2].toLowerCase()];
        if (monthNum) {
            const year = m2[3];
            const month = String(monthNum).padStart(2, '0');
            const day = String(Number(m2[1])).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
    }

    return undefined;
}

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

    // 3. Check English calendar dates with explicit 4-digit year (deterministic, timezone-immune)
    const enDate = parseEnglishDate(trimmed);
    if (enDate) {
        return enDate;
    }

    // 4. Relative time parsing (e.g. 5分钟前, 2小时前, 3天前, 1周前, 2个月前, 1年前, 昨天, 前天)
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
    // Guard: must have a 4-digit year (19xx or 20xx) and an English month name, or be a clean date-like string
    if (trimmed.length <= 50 && /\b(?:19|20)\d{2}\b/.test(trimmed)) {
        const hasMonthName = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(trimmed);
        const isStandardDateLike = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(trimmed) || /^[a-zA-Z]{3},\s+\d{1,2}\s+[a-zA-Z]{3}\s+\d{4}/.test(trimmed);
        if (hasMonthName || isStandardDateLike) {
            const parsed = Date.parse(trimmed);
            if (!Number.isNaN(parsed)) {
                return formatDateIso(new Date(parsed));
            }
        }
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
