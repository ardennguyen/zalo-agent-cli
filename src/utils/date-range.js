/**
 * Date options for search (`--since`, `--until`, `--last`): what a person types, as the epoch milliseconds the cache
 * is queried with.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Period units. A month is 30 days and a year 365: a search window, not a calendar. */
const UNITS = Object.freeze({ h: HOUR, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY });

/**
 * The start of a period that ends now: `7d`, `2w`, `3m`, `1y`, `12h` (Zalo's own presets are 1 week, 1 month, 3 months).
 *
 * @param {string} text
 * @param {number} [now]
 * @returns {number} epoch ms
 * @throws {Error} for anything else
 */
export function parsePeriod(text, now = Date.now()) {
    const m = /^(\d{1,4})\s*([hdwmy])$/i.exec(String(text ?? "").trim());
    if (!m || Number(m[1]) < 1) throw new Error(`Expected a period like 7d, 2w, 3m or 1y, got "${text}".`);
    return now - Number(m[1]) * UNITS[m[2].toLowerCase()];
}

/**
 * A date as a bound of a search. `2026-10-01` means that whole local day: its first millisecond as a lower bound
 * (`edge` "start"), its last as an upper one ("end"). A full date and time (`2026-10-01T09:30`, with or without a zone)
 * is taken as it is.
 *
 * @param {string} text
 * @param {"start"|"end"} edge
 * @returns {number} epoch ms
 * @throws {Error} for a date that is not one
 */
export function parseDateBound(text, edge) {
    const s = String(text ?? "").trim();
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (day) {
        const [y, mo, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
        const start = new Date(y, mo - 1, d);
        // new Date rolls 2026-02-31 into March: that is not a date the person meant.
        if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) {
            throw new Error(`Not a date: "${text}" (use YYYY-MM-DD).`);
        }
        return edge === "end" ? new Date(y, mo - 1, d, 23, 59, 59, 999).getTime() : start.getTime();
    }
    const t = Date.parse(s);
    if (!Number.isFinite(t)) throw new Error(`Not a date: "${text}" (use YYYY-MM-DD or a full date and time).`);
    return t;
}
