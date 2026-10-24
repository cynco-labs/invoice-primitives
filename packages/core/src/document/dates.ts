/** Calendar dates as ISO strings ("2026-10-23"), with no time zone of their own. */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;

function toUtc(date: string): number | undefined {
    const m = DATE.exec(date);
    if (!m) return undefined;
    // setUTCFullYear, because Date.UTC reads years 0 to 99 as 1900 to 1999.
    const d = new Date(0);
    d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const t = d.getTime();
    return d.toISOString().slice(0, 10) === date ? t : undefined;
}

export function isDate(value: string): boolean {
    return toUtc(value) !== undefined;
}

export function addDays(date: string, days: number): string {
    return new Date(toUtc(date)! + days * DAY).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
    return Math.round((toUtc(to)! - toUtc(from)!) / DAY);
}

export function isTimeZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** The calendar date of an instant in an IANA time zone. */
export function localDate(instant: string, timeZone: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}
